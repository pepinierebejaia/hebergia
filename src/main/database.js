const path = require('node:path');
const Realm = require('realm');

const COLLECTIONS = ['users', 'students', 'rooms', 'history', 'complaints', 'blocks', 'floors', 'documentTemplates', 'documentTypes', 'academicRecords', 'housingDossiers', 'academicPeriods', 'renewalCampaigns', 'renewalEvents'];

const schemas = [
  { name: 'User', primaryKey: 'id', properties: { id: 'string', username: 'string', password: 'string', name: 'string', phone: 'string?', role: 'string', bloc: 'string?', active: 'bool', avatar: 'string?' } },
  { name: 'Student', primaryKey: 'id', properties: { id: 'string', matricule: 'string', anneeBac: 'int', numeroInscription: 'string?', nom: 'string', prenom: 'string', nomComplet: 'string?', sexe: 'string?', nationalite: 'string?', dateNaissance: 'string', lieuNaissance: 'string?', filiere: 'string?', faculte: 'string', niveau: 'string', telephone: 'string', email: 'string?', rue: 'string', commune: 'string', wilaya: 'string', statut: 'string', chambreId: 'string?', avatar: 'string?' } },
  { name: 'Room', primaryKey: 'id', properties: { id: 'string', bloc: 'string', numero: 'string', capacite: 'int', statut: 'string' } },
  { name: 'History', primaryKey: 'id', properties: { id: 'string', date: 'string', type: 'string', studentId: 'string', studentName: 'string', roomId: 'string?', roomLabel: 'string', bloc: 'string', fromRoomLabel: 'string?', motif: 'string', userName: 'string', academicYear: 'string?', dossierId: 'string?' } },
  { name: 'Complaint', primaryKey: 'id', properties: { id: 'string', roomId: 'string', roomLabel: 'string', bloc: 'string', type: 'string', description: 'string', priorite: 'string', statut: 'string', declaredByType: 'string', declaredByName: 'string', declaredAt: 'string', assignedToName: 'string?', resolvedAt: 'string?' } },
  { name: 'Block', primaryKey: 'id', properties: { id: 'string', name: 'string', ordre: 'int', genre: 'string?' } },
  { name: 'Floor', primaryKey: 'id', properties: { id: 'string', bloc: 'string', numero: 'int' } },
  { name: 'DocumentTemplate', primaryKey: 'id', properties: { id: 'string', name: 'string', type: 'string', description: 'string', isDefault: 'bool', createdAt: 'string', updatedAt: 'string', settings: 'string' } },
  { name: 'DocumentType', primaryKey: 'id', properties: { id: 'string', name: 'string', createdAt: 'string' } },
  { name: 'AcademicRecord', primaryKey: 'id', properties: { id: 'string', studentId: 'string', academicYear: 'string', filiere: 'string', faculte: 'string', niveau: 'string', decision: 'string', updatedAt: 'string' } },
  { name: 'HousingDossier', primaryKey: 'id', properties: { id: 'string', studentId: 'string', academicYear: 'string', status: 'string', notes: 'string', submittedAt: 'string?', decisionAt: 'string?', updatedAt: 'string', campaignId: 'string?', assignmentStatus: 'string?', assignmentAction: 'string?', targetRoomId: 'string?', assignedRoomId: 'string?', assignmentReason: 'string?', assignmentConfirmedAt: 'string?', renewalStatus: 'string?', closedAt: 'string?', closedBy: 'string?' } },
  { name: 'AcademicPeriod', primaryKey: 'id', properties: { id: 'string', academicYear: 'string', renewalsOpen: 'bool', updatedAt: 'string' } },
  { name: 'RenewalCampaign', primaryKey: 'id', properties: { id: 'string', academicYear: 'string', startDate: 'string?', endDate: 'string?', status: 'string', createdAt: 'string', updatedAt: 'string', createdBy: 'string' } },
  { name: 'RenewalEvent', primaryKey: 'id', properties: { id: 'string', campaignId: 'string', dossierId: 'string?', studentId: 'string?', type: 'string', occurredAt: 'string', actorId: 'string', actorName: 'string', fromRoomId: 'string?', toRoomId: 'string?', reason: 'string', sequence: 'int' } }
];

const modelMap = { users: 'User', students: 'Student', rooms: 'Room', history: 'History', complaints: 'Complaint', blocks: 'Block', floors: 'Floor', documentTemplates: 'DocumentTemplate', documentTypes: 'DocumentType', academicRecords: 'AcademicRecord', housingDossiers: 'HousingDossier', academicPeriods: 'AcademicPeriod', renewalCampaigns: 'RenewalCampaign', renewalEvents: 'RenewalEvent' };
let realm;
let realmPath;

function openDatabase(userDataPath) {
  const nextPath = path.join(userDataPath, 'hebergia.realm');
  if (realm && !realm.isClosed && realmPath !== nextPath) realm.close();
  if (!realm || realm.isClosed || realmPath !== nextPath) {
    realm = new Realm({ path: nextPath, schema: schemas, schemaVersion: 15, migration: (oldRealm, newRealm) => {
      if (oldRealm.schemaVersion < 9) for (const student of newRealm.objects('Student')) student.avatar = null;
      if (oldRealm.schemaVersion < 12) for (const block of newRealm.objects('Block')) block.genre = 'mixte';
    } });
    realmPath = nextPath;
  }
  return realm;
}

function plain(value, excludePhotoData = false) {
  if (value == null || typeof value !== 'object') return value;
  if (typeof value[Symbol.iterator] === 'function') return Array.from(value, item => plain(item, excludePhotoData));
  const result = {};
  for (const key of Object.keys(value)) {
    const field = value[key];
    if (excludePhotoData && key === 'avatar' && typeof field === 'string' && field.startsWith('data:image/')) continue;
    result[key] = plain(field, excludePhotoData);
  }
  return result;
}

function ensureCollection(collection) {
  if (!COLLECTIONS.includes(collection)) throw new Error('Collection invalide.');
  return modelMap[collection];
}

function requireUser(db, actorId, adminOnly = false) {
  const user = db.objectForPrimaryKey('User', String(actorId || ''));
  if (!user || !user.active) throw new Error('Session utilisateur invalide ou désactivée.');
  if (adminOnly && user.role !== 'admin') throw new Error('Cette action est réservée à l’administrateur.');
  if (!['admin', 'agent', 'user'].includes(user.role)) throw new Error('Rôle utilisateur invalide.');
  return user;
}

function requireStudentAccess(db, actor, student) {
  if (actor.role === 'admin') return;
  const room = student.chambreId && db.objectForPrimaryKey('Room', student.chambreId);
  if (!actor.bloc || room?.bloc !== actor.bloc) throw new Error('Accès au renouvellement interdit hors de votre bloc.');
}

function requireRoomAccess(actor, room) {
  if (actor.role !== 'admin' && (!actor.bloc || room.bloc !== actor.bloc)) {
    throw new Error('Affectation interdite hors de votre bloc.');
  }
}

function campaignIdFor(year) {
  return `renewal-${year}`;
}

function dossierIdFor(studentId, year) {
  return `housing-${studentId}-${year}`;
}

function eventFor({ campaignId, dossierId = null, studentId = null, type, actor, now, fromRoomId = null, toRoomId = null, reason = '', sequence = 0 }) {
  return {
    id: `renewal-event-${require('node:crypto').randomUUID()}`,
    campaignId,
    dossierId,
    studentId,
    type,
    occurredAt: now,
    actorId: actor.id,
    actorName: actor.name,
    fromRoomId,
    toRoomId,
    reason,
    sequence
  };
}

function ensureDossier(db, student, campaign, now = new Date().toISOString()) {
  const id = dossierIdFor(student.id, campaign.academicYear);
  const matches = [...db.objects('HousingDossier')].filter(item => item.studentId === student.id && item.academicYear === campaign.academicYear);
  if (matches.length > 1) throw new Error(`Plusieurs dossiers de renouvellement existent pour ${student.id} en ${campaign.academicYear}.`);
  let dossier = matches[0] || db.objectForPrimaryKey('HousingDossier', id);
  if (!dossier) {
    db.create('HousingDossier', {
      id,
      studentId: student.id,
      academicYear: campaign.academicYear,
      status: student.statut === 'actif' ? 'a_renouveler' : 'clos',
      notes: '',
      submittedAt: null,
      decisionAt: null,
      updatedAt: now,
      campaignId: campaign.id,
      assignmentStatus: 'a_decider',
      assignmentAction: null,
      targetRoomId: null,
      assignedRoomId: null,
      assignmentReason: '',
      assignmentConfirmedAt: null,
      renewalStatus: 'en_cours',
      closedAt: null,
      closedBy: null
    });
    dossier = db.objectForPrimaryKey('HousingDossier', id);
  } else if (dossier.campaignId !== campaign.id) {
    dossier.campaignId = campaign.id;
  }
  return dossier;
}

function requireOpenCampaign(db, campaignId) {
  const campaign = db.objectForPrimaryKey('RenewalCampaign', campaignId);
  if (!campaign) throw new Error('Campagne de renouvellement introuvable.');
  if (campaign.status !== 'ouverte') throw new Error('Cette campagne n’est pas ouverte.');
  return campaign;
}

function requireDossier(db, dossierId) {
  const dossier = db.objectForPrimaryKey('HousingDossier', dossierId);
  if (!dossier) throw new Error('Dossier de renouvellement introuvable.');
  const campaign = db.objectForPrimaryKey('RenewalCampaign', dossier.campaignId || campaignIdFor(dossier.academicYear));
  if (!campaign) throw new Error('Campagne du dossier introuvable.');
  return { dossier, campaign };
}

function normalizeGender(value) {
  return String(value || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z]/g, '');
}

function assertRoomGenderCompatible(db, student, room) {
  const block = [...db.objects('Block')].find(item => item.name.trim().toLocaleLowerCase('fr') === room.bloc.trim().toLocaleLowerCase('fr'));
  const blockGender = normalizeGender(block?.genre || 'mixte');
  if (!blockGender || blockGender === 'mixte') return;
  const studentGender = normalizeGender(student.sexe);
  const isGirl = ['f', 'femme', 'feminin', 'feminine', 'female', 'fille', 'filles', 'woman', 'women'].includes(studentGender);
  const isBoy = ['m', 'h', 'homme', 'masculin', 'masculine', 'male', 'garcon', 'garcons', 'man', 'men'].includes(studentGender);
  const girlsBlock = ['fille', 'filles', 'femme', 'femmes', 'feminin', 'feminine', 'female', 'women'].includes(blockGender);
  const boysBlock = ['garcon', 'garcons', 'homme', 'hommes', 'masculin', 'masculine', 'male', 'men'].includes(blockGender);
  if ((girlsBlock && !isGirl) || (boysBlock && !isBoy)) {
    throw new Error(`Affectation impossible : le résident ne peut pas être affecté au bloc ${room.bloc}.`);
  }
}

function latestKeyEvent(db, studentId) {
  return [...db.objects('RenewalEvent')]
    .filter(event => event.studentId === studentId && ['cle_remise', 'cle_restituee'].includes(event.type))
    .sort((a, b) => b.sequence - a.sequence)[0] || null;
}

function validateAcademicYear(year) {
  if (academicYearStart(year) === null) throw new Error('Année universitaire invalide; format attendu : AAAA/AAAA.');
}

function api(userDataPath) {
  const getRealm = () => openDatabase(userDataPath);
  return {
    init(seed) {
      const db = getRealm();
      db.write(() => {
        for (const collection of COLLECTIONS) {
          const model = ensureCollection(collection);
          if (db.objects(model).length === 0 && Array.isArray(seed?.[collection])) {
            for (const document of seed[collection]) db.create(model, document, Realm.UpdateMode.Modified);
          }
        }
        if (db.objects('Block').length === 0) {
          const names = [...new Set([...db.objects('Room')].map(room => room.bloc))].sort();
          names.forEach((name, ordre) => db.create('Block', { id: `block-${name}`, name, ordre, genre: 'mixte' }, Realm.UpdateMode.Modified));
        }
        if (db.objects('Floor').length === 0) {
          const pairs = new Set([...db.objects('Room')].map(room => `${room.bloc}|${parseInt(String(room.numero).slice(0, -2), 10) || 0}`));
          for (const key of pairs) {
            const [bloc, raw] = key.split('|');
            db.create('Floor', { id: `floor-${bloc}-${raw}`, bloc, numero: Number(raw) }, Realm.UpdateMode.Modified);
          }
        }
        let academicPeriod = db.objectForPrimaryKey('AcademicPeriod', 'active');
        if (!academicPeriod) {
          const academicYear = academicYearFor(new Date());
          db.create('AcademicPeriod', { id: 'active', academicYear, renewalsOpen: false, updatedAt: new Date().toISOString() });
          academicPeriod = db.objectForPrimaryKey('AcademicPeriod', 'active');
        } else if (academicYearStart(academicPeriod.academicYear) === null) {
          Object.assign(academicPeriod, { academicYear: academicYearFor(new Date()), renewalsOpen: false, updatedAt: new Date().toISOString() });
        }
        const currentAcademicYear = academicPeriod.academicYear;
        const currentCampaignId = campaignIdFor(currentAcademicYear);
        let campaign = db.objectForPrimaryKey('RenewalCampaign', currentCampaignId);
        if (!campaign) {
          const now = new Date().toISOString();
          db.create('RenewalCampaign', {
            id: currentCampaignId,
            academicYear: currentAcademicYear,
            startDate: null,
            endDate: null,
            status: academicPeriod.renewalsOpen ? 'ouverte' : 'brouillon',
            createdAt: now,
            updatedAt: now,
            createdBy: ''
          });
          campaign = db.objectForPrimaryKey('RenewalCampaign', currentCampaignId);
        }
        for (const existingCampaign of db.objects('RenewalCampaign')) {
          if (existingCampaign.status === 'ouverte' && existingCampaign.academicYear !== currentAcademicYear && !academicPeriod.renewalsOpen) {
            existingCampaign.status = 'suspendue';
            existingCampaign.updatedAt = new Date().toISOString();
          }
        }
        const historicalYears = new Set([...db.objects('HousingDossier')].map(dossier => dossier.academicYear).filter(year => year !== currentAcademicYear && academicYearStart(year) !== null));
        for (const year of historicalYears) {
          const historicalCampaignId = campaignIdFor(year);
          if (!db.objectForPrimaryKey('RenewalCampaign', historicalCampaignId)) {
            const now = new Date().toISOString();
            db.create('RenewalCampaign', {
              id: historicalCampaignId,
              academicYear: year,
              startDate: null,
              endDate: null,
              status: 'cloturee',
              createdAt: now,
              updatedAt: now,
              createdBy: ''
            });
          }
          for (const dossier of db.objects('HousingDossier').filtered('academicYear == $0', year)) dossier.campaignId = historicalCampaignId;
        }
        for (const student of db.objects('Student')) {
          const academicId = `academic-${student.id}-${currentAcademicYear}`;
          if (!db.objectForPrimaryKey('AcademicRecord', academicId)) {
            const currentYearStart = academicYearStart(currentAcademicYear);
            const previous = [...db.objects('AcademicRecord')]
              .filter(record => record.studentId === student.id && academicYearStart(record.academicYear) !== null && academicYearStart(record.academicYear) < currentYearStart)
              .sort((a, b) => academicYearStart(b.academicYear) - academicYearStart(a.academicYear))[0];
            const promoted = previous?.decision === 'admis';
            db.create('AcademicRecord', {
              id: academicId,
              studentId: student.id,
              academicYear: currentAcademicYear,
              filiere: previous?.filiere || student.filiere || '',
              faculte: previous?.faculte || student.faculte || '',
              niveau: promoted ? nextAcademicLevel(previous.niveau) : previous?.niveau || student.niveau || '',
              decision: 'en_attente',
              updatedAt: new Date().toISOString()
            });
          }
          ensureDossier(db, student, campaign);
        }
      });
      return true;
    },

    list(collection, options = {}) {
      const rows = getRealm().objects(ensureCollection(collection));
      return plain(rows, collection === 'students' && options?.excludePhotoData === true);
    },
    ensureRenewalDossier(studentId, campaignId, actorId) {
      const db = getRealm();
      const actor = requireUser(db, actorId);
      let dossier;
      db.write(() => {
        const campaign = db.objectForPrimaryKey('RenewalCampaign', campaignId);
        if (!campaign || campaign.status !== 'ouverte') throw new Error('Cette campagne n’est pas ouverte.');
        const student = db.objectForPrimaryKey('Student', studentId);
        if (!student || student.statut !== 'actif') throw new Error('Résident actif introuvable.');
        requireStudentAccess(db, actor, student);
        dossier = ensureDossier(db, student, campaign);
      });
      return plain(dossier);
    },
    renewalSnapshot(actorId) {
      const db = getRealm();
      const actor = requireUser(db, actorId);
      const rooms = [...db.objects('Room')].filter(room => actor.role === 'admin' || room.bloc === actor.bloc);
      const roomIds = new Set(rooms.map(room => room.id));
      const students = [...db.objects('Student')].filter(student => actor.role === 'admin' || (student.chambreId && roomIds.has(student.chambreId)));
      const studentIds = new Set(students.map(student => student.id));
      const dossiers = [...db.objects('HousingDossier')].filter(dossier => studentIds.has(dossier.studentId));
      const dossierIds = new Set(dossiers.map(dossier => dossier.id));
      return {
        students: plain(students, true),
        rooms: plain(rooms),
        blocks: plain([...db.objects('Block')].filter(block => actor.role === 'admin' || block.name === actor.bloc)),
        history: plain([...db.objects('History')].filter(item => studentIds.has(item.studentId) || dossierIds.has(item.dossierId))),
        academicRecords: plain([...db.objects('AcademicRecord')].filter(record => studentIds.has(record.studentId))),
        housingDossiers: plain(dossiers),
        academicPeriods: plain(db.objects('AcademicPeriod')),
        renewalCampaigns: plain(db.objects('RenewalCampaign')),
        renewalEvents: plain([...db.objects('RenewalEvent')].filter(event => !event.studentId || studentIds.has(event.studentId)))
      };
    },
    get(collection, id) { return plain(getRealm().objectForPrimaryKey(ensureCollection(collection), id)); },
    insert(collection, document) { const db = getRealm(); db.write(() => db.create(ensureCollection(collection), document)); return plain(document); },
    update(collection, id, patch) {
      const db = getRealm(); const model = ensureCollection(collection); const existing = db.objectForPrimaryKey(model, id);
      if (!existing) throw new Error('Enregistrement introuvable.');
      const safePatch = Object.fromEntries(Object.entries(patch).filter(([key]) => key !== 'id'));
      db.write(() => Object.assign(existing, safePatch)); return plain(existing);
    },
    remove(collection, id) {
      const db = getRealm(); const existing = db.objectForPrimaryKey(ensureCollection(collection), id);
      if (existing) db.write(() => db.delete(existing)); return true;
    },
    replaceAll(data) {
      const db = getRealm();
      db.write(() => { db.deleteAll(); for (const collection of COLLECTIONS) for (const document of (data?.[collection] || [])) db.create(ensureCollection(collection), document, Realm.UpdateMode.Modified); });
      return true;
    },
    wipe() { const db = getRealm(); db.write(() => db.deleteAll()); return true; },
    createRenewalCampaign(input, actorId) {
      const db = getRealm();
      const actor = requireUser(db, actorId, true);
      const year = String(input?.academicYear || '').trim();
      validateAcademicYear(year);
      const startDate = String(input?.startDate || '').trim();
      const endDate = String(input?.endDate || '').trim();
      const isDate = value => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
        const date = new Date(`${value}T00:00:00.000Z`);
        return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
      };
      if (!isDate(startDate)) throw new Error('La date de début de campagne est obligatoire et doit être valide.');
      if (!isDate(endDate)) throw new Error('La date de fin de campagne est obligatoire et doit être valide.');
      if (startDate > endDate) throw new Error('La date de fin doit être postérieure ou égale à la date de début.');
      const campaignId = campaignIdFor(year);
      const now = new Date().toISOString();
      let created;
      db.write(() => {
        if ([...db.objects('RenewalCampaign')].some(item => item.academicYear === year)) throw new Error(`Une campagne existe déjà pour ${year}.`);
        created = db.create('RenewalCampaign', {
          id: campaignId, academicYear: year, startDate, endDate,
          status: 'brouillon', createdAt: now, updatedAt: now, createdBy: actor.id
        });
        for (const student of db.objects('Student')) ensureDossier(db, student, created, now);
        db.create('RenewalEvent', eventFor({ campaignId, type: 'campagne_creee', actor, now }));
      });
      return plain(created);
    },
    updateRenewalCampaignDates({ campaignId, startDate, endDate }, actorId) {
      const db = getRealm();
      const actor = requireUser(db, actorId, true);
      const validDate = value => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
        const date = new Date(`${value}T00:00:00.000Z`);
        return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
      };
      const start = String(startDate || '').trim();
      const end = String(endDate || '').trim();
      if (!validDate(start) || !validDate(end)) throw new Error('Les dates de campagne sont obligatoires et doivent être valides.');
      if (start > end) throw new Error('La date de fin doit être postérieure ou égale à la date de début.');
      const now = new Date().toISOString();
      let updated;
      db.write(() => {
        const campaign = db.objectForPrimaryKey('RenewalCampaign', campaignId);
        if (!campaign) throw new Error('Campagne de renouvellement introuvable.');
        if (campaign.status === 'cloturee') throw new Error('Les dates d’une campagne clôturée ne peuvent plus être modifiées.');
        campaign.startDate = start;
        campaign.endDate = end;
        campaign.updatedAt = now;
        db.create('RenewalEvent', eventFor({ campaignId: campaign.id, type: 'campagne_dates_modifiees', actor, now }));
        updated = campaign;
      });
      return plain(updated);
    },
    setRenewalCampaignStatus(campaignId, status, actorId) {
      const db = getRealm();
      const actor = requireUser(db, actorId, true);
      if (!['ouverte', 'suspendue', 'cloturee'].includes(status)) throw new Error('Statut de campagne invalide.');
      const now = new Date().toISOString();
      let updated;
      db.write(() => {
        const campaign = db.objectForPrimaryKey('RenewalCampaign', campaignId);
        if (!campaign) throw new Error('Campagne de renouvellement introuvable.');
        const transitions = { brouillon: ['ouverte'], ouverte: ['suspendue', 'cloturee'], suspendue: ['ouverte', 'cloturee'], cloturee: [] };
        if (!transitions[campaign.status]?.includes(status)) throw new Error(`Transition de campagne impossible : ${campaign.status} vers ${status}.`);
        if (status === 'ouverte' && (!campaign.startDate || !campaign.endDate)) throw new Error('Renseignez les dates de début et de fin avant d’ouvrir la campagne.');
        if (status === 'ouverte' && [...db.objects('RenewalCampaign')].some(item => item.id !== campaign.id && item.status === 'ouverte')) {
          throw new Error('Suspendez ou clôturez d’abord la campagne actuellement ouverte.');
        }
        campaign.status = status;
        campaign.updatedAt = now;
        const period = db.objectForPrimaryKey('AcademicPeriod', 'active');
        if (period && (period.academicYear === campaign.academicYear || status === 'ouverte')) {
          period.academicYear = campaign.academicYear;
          period.renewalsOpen = status === 'ouverte';
          period.updatedAt = now;
        }
        db.create('RenewalEvent', eventFor({ campaignId: campaign.id, type: `campagne_${status}`, actor, now }));
        updated = campaign;
      });
      return plain(updated);
    },
    updateRenewalDossier({ dossierId, status, notes, academicData = null }, actorId) {
      const db = getRealm();
      const actor = requireUser(db, actorId);
      const now = new Date().toISOString();
      let updated;
      db.write(() => {
        const { dossier, campaign } = requireDossier(db, dossierId);
        if (campaign.status !== 'ouverte') throw new Error('Cette campagne n’est pas ouverte.');
        if (!['a_renouveler', 'en_preparation', 'incomplet', 'soumis', 'accepte', 'refuse'].includes(status)) throw new Error('État de dossier invalide.');
        if (dossier.renewalStatus === 'cloture') throw new Error('Ce renouvellement est déjà clôturé.');
        if (dossier.assignmentStatus === 'confirmee' && status !== 'accepte') throw new Error('Une affectation confirmée exige que le dossier reste accepté.');
        const student = db.objectForPrimaryKey('Student', dossier.studentId);
        if (!student) throw new Error('Résident du dossier introuvable.');
        requireStudentAccess(db, actor, student);
        let annualRecord = null;
        let previousRecord = null;
        let academicFields = null;
        if (academicData) {
          academicFields = {
            filiere: String(academicData.filiere || '').trim(),
            faculte: String(academicData.faculte || '').trim(),
            niveau: String(academicData.niveau || '').trim()
          };
          if (!academicFields.filiere || !academicFields.faculte || !academicFields.niveau) throw new Error('La filière, la faculté et le niveau d’étude sont obligatoires.');
          annualRecord = db.objectForPrimaryKey('AcademicRecord', String(academicData.annualRecordId || ''));
          if (!annualRecord || annualRecord.studentId !== student.id || annualRecord.academicYear !== campaign.academicYear) throw new Error('Le dossier académique annuel est introuvable.');
          if (academicData.previousRecordId) {
            previousRecord = db.objectForPrimaryKey('AcademicRecord', String(academicData.previousRecordId));
            const previousYearStart = academicYearStart(previousRecord?.academicYear);
            const campaignYearStart = academicYearStart(campaign.academicYear);
            if (!previousRecord || previousRecord.studentId !== student.id || previousYearStart === null || campaignYearStart === null || previousYearStart >= campaignYearStart) throw new Error('Le dossier académique précédent est invalide.');
            const previousDecision = String(academicData.previousDecision || '');
            if (!['en_attente', 'admis', 'redouble'].includes(previousDecision)) throw new Error('Résultat académique invalide.');
            const expected = previousDecision === 'admis' ? nextAcademicLevel(previousRecord.niveau) : previousRecord.niveau;
            if (previousDecision !== 'en_attente' && academicFields.niveau.toLocaleLowerCase('fr') !== expected.toLocaleLowerCase('fr')) {
              throw new Error(previousDecision === 'admis' ? `Après admission, le niveau attendu est ${expected}.` : `En cas de redoublement, le niveau doit rester ${previousRecord.niveau}.`);
            }
          }
        }
        if (academicFields) {
          Object.assign(annualRecord, { ...academicFields, updatedAt: now });
          if (previousRecord) Object.assign(previousRecord, { decision: String(academicData.previousDecision), updatedAt: now });
          Object.assign(student, academicFields);
        }
        dossier.status = status;
        dossier.notes = String(notes || '').trim();
        if (status === 'refuse' && dossier.assignmentStatus !== 'confirmee') {
          dossier.assignmentStatus = 'a_decider';
          dossier.assignmentAction = null;
          dossier.targetRoomId = null;
          dossier.assignmentReason = '';
        }
        dossier.submittedAt = ['soumis', 'accepte'].includes(status) ? (dossier.submittedAt || now) : null;
        dossier.decisionAt = ['accepte', 'refuse'].includes(status) ? now : null;
        dossier.updatedAt = now;
        db.create('RenewalEvent', eventFor({
          campaignId: campaign.id, dossierId: dossier.id, studentId: student.id,
          type: `dossier_${status}`,
          actor, now
        }));
        if (academicFields) db.create('RenewalEvent', eventFor({
          campaignId: campaign.id, dossierId: dossier.id, studentId: student.id,
          type: 'dossier_academique_modifie', actor, now
        }));
        updated = dossier;
      });
      return plain(updated);
    },
    setRenewalAssignment({ dossierId, roomId = null, reason = '' }, actorId) {
      const db = getRealm();
      const actor = requireUser(db, actorId);
      const now = new Date().toISOString();
      let updated;
      db.write(() => {
        const { dossier, campaign } = requireDossier(db, dossierId);
        requireOpenCampaign(db, campaign.id);
        const student = db.objectForPrimaryKey('Student', dossier.studentId);
        if (!student) throw new Error('Résident du dossier introuvable.');
        requireStudentAccess(db, actor, student);
        if (dossier.status !== 'accepte') throw new Error('Validez le dossier avant de choisir une affectation.');
        if (dossier.renewalStatus === 'cloture') throw new Error('Ce renouvellement est déjà clôturé.');
        if (student.statut !== 'actif') throw new Error('Seul un résident actif peut être affecté.');
        if (roomId) {
          const room = db.objectForPrimaryKey('Room', roomId);
          if (!room) throw new Error('Chambre cible introuvable.');
          requireRoomAccess(actor, room);
          if (room.statut === 'hors_service') throw new Error('Cette chambre est hors service.');
          assertRoomGenderCompatible(db, student, room);
        }
        dossier.targetRoomId = roomId || null;
        dossier.assignmentStatus = roomId ? 'a_confirmer' : 'en_attente';
        dossier.assignmentAction = roomId ? (student.chambreId === roomId ? 'reconduite' : student.chambreId ? 'modifiee' : 'nouvelle') : null;
        dossier.assignmentReason = String(reason || '').trim();
        dossier.updatedAt = now;
        db.create('RenewalEvent', eventFor({
          campaignId: campaign.id, dossierId: dossier.id, studentId: student.id,
          type: roomId ? 'affectation_proposee' : 'affectation_en_attente',
          actor, now, fromRoomId: student.chambreId, toRoomId: roomId || null, reason: dossier.assignmentReason
        }));
        updated = dossier;
      });
      return plain(updated);
    },
    confirmRenewalAssignment(dossierId, actorId) {
      const db = getRealm();
      const actor = requireUser(db, actorId);
      const now = new Date().toISOString();
      let updated;
      db.write(() => {
        const { dossier, campaign } = requireDossier(db, dossierId);
        requireOpenCampaign(db, campaign.id);
        if (dossier.status !== 'accepte') throw new Error('Validez le dossier avant de confirmer l’affectation.');
        if (dossier.renewalStatus === 'cloture') throw new Error('Ce renouvellement est déjà clôturé.');
        if (dossier.assignmentStatus !== 'a_confirmer' || !dossier.targetRoomId) throw new Error('Choisissez une chambre avant de confirmer l’installation.');
        const student = db.objectForPrimaryKey('Student', dossier.studentId);
        const room = db.objectForPrimaryKey('Room', dossier.targetRoomId);
        if (!student || student.statut !== 'actif') throw new Error('Résident actif introuvable.');
        requireStudentAccess(db, actor, student);
        if (!room) throw new Error('Chambre cible introuvable.');
        requireRoomAccess(actor, room);
        if (room.statut === 'hors_service') throw new Error('Cette chambre est hors service.');
        assertRoomGenderCompatible(db, student, room);
        const occupants = [...db.objects('Student')].filter(item => item.id !== student.id && item.statut === 'actif' && item.chambreId === room.id).length;
        if (occupants >= room.capacite) throw new Error(`Capacité atteinte : ${room.bloc} ${room.numero} est complète (${occupants}/${room.capacite}).`);
        const previousRoom = student.chambreId ? db.objectForPrimaryKey('Room', student.chambreId) : null;
        const moved = student.chambreId !== room.id;
        student.chambreId = room.id;
        student.statut = 'actif';
        dossier.assignedRoomId = room.id;
        dossier.assignmentStatus = 'confirmee';
        dossier.assignmentAction = moved ? (previousRoom ? 'modifiee' : 'nouvelle') : 'reconduite';
        dossier.assignmentConfirmedAt = now;
        dossier.updatedAt = now;
        if (moved) {
          db.create('History', {
            id: `history-renewal-${require('node:crypto').randomUUID()}`,
            date: now,
            type: previousRoom ? 'transfert' : 'entree',
            studentId: student.id,
            studentName: `${student.nom} ${student.prenom}`,
            roomId: room.id,
            roomLabel: `${room.bloc} ${room.numero}`,
            bloc: room.bloc,
            fromRoomLabel: previousRoom ? `${previousRoom.bloc} ${previousRoom.numero}` : null,
            motif: dossier.assignmentReason || (previousRoom ? 'Changement de chambre lors du renouvellement' : 'Affectation lors du renouvellement'),
            userName: actor.name,
            academicYear: campaign.academicYear,
            dossierId: dossier.id
          });
        }
        db.create('RenewalEvent', eventFor({
          campaignId: campaign.id, dossierId: dossier.id, studentId: student.id,
          type: moved ? 'affectation_modifiee' : 'affectation_reconduite',
          actor, now, fromRoomId: previousRoom?.id || null, toRoomId: room.id,
          reason: dossier.assignmentReason
        }));
        updated = dossier;
      });
      return plain(updated);
    },
    recordRenewalKeyOperation({ dossierId, operation, reason = '' }, actorId) {
      const db = getRealm();
      const actor = requireUser(db, actorId);
      if (!['remise', 'restitution'].includes(operation)) throw new Error('Opération de clé invalide.');
      const now = new Date().toISOString();
      let created;
      db.write(() => {
        const { dossier, campaign } = requireDossier(db, dossierId);
        requireOpenCampaign(db, campaign.id);
        if (dossier.status !== 'accepte' || dossier.assignmentStatus !== 'confirmee') throw new Error('Confirmez d’abord le renouvellement et l’installation.');
        const student = db.objectForPrimaryKey('Student', dossier.studentId);
        if (!student) throw new Error('Résident du dossier introuvable.');
        requireStudentAccess(db, actor, student);
        const latest = latestKeyEvent(db, dossier.studentId);
        const installationHandover = dossier.assignmentStatus === 'confirmee'
          && (!latest || (dossier.assignmentConfirmedAt
            ? latest.occurredAt < dossier.assignmentConfirmedAt
            : latest.type === 'cle_remise'));
        if (operation === 'restitution' && latest?.type !== 'cle_remise' && !installationHandover) throw new Error('Restitution impossible : aucune remise préalable n’est enregistrée.');
        if (operation === 'remise' && (latest?.type === 'cle_remise' || installationHandover)) throw new Error('Cette clé est déjà enregistrée comme remise au résident.');
        const sequence = (latest?.sequence || 0) + 1;
        created = db.create('RenewalEvent', eventFor({
          campaignId: campaign.id,
          dossierId: dossier.id,
          studentId: dossier.studentId,
          type: operation === 'remise' ? 'cle_remise' : 'cle_restituee',
          actor,
          now,
          toRoomId: dossier.assignedRoomId,
          reason: String(reason || '').trim(),
          sequence
        }));
      });
      return plain(created);
    },
    closeRenewalDossier(dossierId, actorId) {
      const db = getRealm();
      const actor = requireUser(db, actorId);
      const now = new Date().toISOString();
      let updated;
      db.write(() => {
        const { dossier, campaign } = requireDossier(db, dossierId);
        requireOpenCampaign(db, campaign.id);
        if (dossier.status !== 'accepte') throw new Error('Seul un dossier accepté peut être clôturé.');
        if (dossier.renewalStatus === 'cloture') throw new Error('Ce renouvellement est déjà clôturé.');
        const student = db.objectForPrimaryKey('Student', dossier.studentId);
        if (!student) throw new Error('Résident du dossier introuvable.');
        requireStudentAccess(db, actor, student);
        if (dossier.assignmentStatus !== 'confirmee' || !dossier.assignedRoomId) {
          const currentRoom = student.chambreId && db.objectForPrimaryKey('Room', student.chambreId);
          const pendingMove = dossier.assignmentStatus === 'a_confirmer'
            && dossier.targetRoomId && dossier.targetRoomId !== student.chambreId;
          if (student.statut !== 'actif' || !currentRoom || pendingMove) {
            throw new Error('Confirmez l’affectation et l’installation avant de clôturer.');
          }
          dossier.assignedRoomId = currentRoom.id;
          dossier.targetRoomId = currentRoom.id;
          dossier.assignmentStatus = 'confirmee';
          dossier.assignmentAction = 'reconduite';
          dossier.assignmentConfirmedAt = now;
          db.create('RenewalEvent', eventFor({
            campaignId: campaign.id, dossierId: dossier.id, studentId: student.id,
            type: 'affectation_reconduite', actor, now,
            fromRoomId: currentRoom.id, toRoomId: currentRoom.id
          }));
        }
        if (student.chambreId !== dossier.assignedRoomId) throw new Error('L’affectation actuelle ne correspond plus au dossier annuel.');
        dossier.renewalStatus = 'cloture';
        dossier.closedAt = now;
        dossier.closedBy = actor.id;
        dossier.updatedAt = now;
        db.create('RenewalEvent', eventFor({ campaignId: campaign.id, dossierId: dossier.id, studentId: dossier.studentId, type: 'renouvellement_cloture', actor, now }));
        updated = dossier;
      });
      return plain(updated);
    },
    close() {
      if (realm && !realm.isClosed && realmPath === path.join(userDataPath, 'hebergia.realm')) realm.close();
      realm = null;
      realmPath = null;
    }
  };
}

function academicYearFor(date) {
  const year = date.getFullYear();
  const start = date.getMonth() >= 8 ? year : year - 1;
  return `${start}/${start + 1}`;
}

function academicYearStart(value) {
  const match = String(value || '').match(/^(\d{4})\/(\d{4})$/);
  return match && Number(match[2]) === Number(match[1]) + 1 ? Number(match[1]) : null;
}

function nextAcademicLevel(level) {
  const normalized = String(level || '').trim();
  const levels = ['L1', 'L2', 'L3', 'M1', 'M2', 'Doctorat'];
  const index = levels.findIndex(item => item.toLowerCase() === normalized.toLowerCase());
  if (index >= 0) return levels[Math.min(index + 1, levels.length - 1)];
  const numbered = normalized.match(/^(.*?)(\d+)$/);
  return numbered ? `${numbered[1]}${Number(numbered[2]) + 1}` : normalized;
}

module.exports = { api };
