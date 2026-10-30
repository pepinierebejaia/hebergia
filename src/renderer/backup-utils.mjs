const REQUIRED_COLLECTIONS = ['users', 'students', 'rooms', 'history', 'complaints', 'blocks', 'floors'];
const OPTIONAL_COLLECTIONS = [
  'documentTemplates',
  'documentTypes',
  'academicRecords',
  'housingDossiers',
  'academicPeriods',
  'renewalCampaigns',
  'renewalEvents'
];
const COLLECTIONS = [...REQUIRED_COLLECTIONS, ...OPTIONAL_COLLECTIONS];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(record, field, collection) {
  if (typeof record[field] !== 'string' || !record[field].trim()) {
    throw new Error(`La sauvegarde contient un champ « ${field} » invalide dans « ${collection} ».`);
  }
}

function requirePositiveInteger(value, field, collection) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`La sauvegarde contient un champ « ${field} » invalide dans « ${collection} ».`);
  }
}

export function validateBackupPayload(payload) {
  if (!isRecord(payload)) throw new Error('Le fichier de sauvegarde doit contenir un objet JSON.');
  if (payload.version !== undefined && (!Number.isInteger(payload.version) || payload.version < 1 || payload.version > 4)) {
    throw new Error('La version de cette sauvegarde n’est pas prise en charge.');
  }

  const data = payload.data === undefined ? payload : payload.data;
  if (!isRecord(data)) throw new Error('Le contenu de la sauvegarde est invalide.');

  for (const collection of REQUIRED_COLLECTIONS) {
    if (!Array.isArray(data[collection])) {
      throw new Error(`La sauvegarde est incomplète : la collection « ${collection} » est absente ou invalide.`);
    }
  }

  const normalized = Object.fromEntries(COLLECTIONS.map(collection => [
    collection,
    data[collection] === undefined && OPTIONAL_COLLECTIONS.includes(collection) ? [] : data[collection]
  ]));
  for (const collection of COLLECTIONS) {
    if (!Array.isArray(normalized[collection])) {
      throw new Error(`La collection « ${collection} » de la sauvegarde est invalide.`);
    }
    const ids = new Set();
    for (const [index, record] of normalized[collection].entries()) {
      if (!isRecord(record)) {
        throw new Error(`Enregistrement ${index + 1} invalide dans la collection « ${collection} ».`);
      }
      requireString(record, 'id', collection);
      if (ids.has(record.id)) {
        throw new Error(`Identifiant « ${record.id} » présent plusieurs fois dans « ${collection} ».`);
      }
      ids.add(record.id);
    }
  }

  const students = normalized.students;
  const matricules = new Set();
  for (const student of students) {
    requireString(student, 'matricule', 'students');
    requireString(student, 'nom', 'students');
    requireString(student, 'prenom', 'students');
    requirePositiveInteger(student.anneeBac, 'anneeBac', 'students');
    if (!['actif', 'sorti'].includes(student.statut)) {
      throw new Error('La sauvegarde contient un statut de résident invalide.');
    }
    if (student.chambreId !== null && student.chambreId !== undefined && typeof student.chambreId !== 'string') {
      throw new Error('La sauvegarde contient une affectation de chambre invalide.');
    }
    const matriculeKey = student.matricule.trim().toLocaleLowerCase('fr');
    if (matricules.has(matriculeKey)) {
      throw new Error(`Le matricule « ${student.matricule} » apparaît plusieurs fois dans la sauvegarde.`);
    }
    matricules.add(matriculeKey);
  }

  const roomIds = new Set();
  for (const room of normalized.rooms) {
    requireString(room, 'bloc', 'rooms');
    requireString(room, 'numero', 'rooms');
    requirePositiveInteger(room.capacite, 'capacite', 'rooms');
    if (!['normal', 'hors_service'].includes(room.statut)) {
      throw new Error(`Statut invalide pour la chambre ${room.bloc} ${room.numero}.`);
    }
    roomIds.add(room.id);
  }
  for (const student of students) {
    if (student.chambreId && !roomIds.has(student.chambreId)) {
      throw new Error(`La chambre affectée au résident ${student.matricule} est absente de la sauvegarde.`);
    }
  }

  const campaignYears = new Set();
  const campaignIds = new Set(normalized.renewalCampaigns.map(campaign => campaign.id));
  for (const campaign of normalized.renewalCampaigns) {
    requireString(campaign, 'academicYear', 'renewalCampaigns');
    if (!/^\d{4}\/\d{4}$/.test(campaign.academicYear) || Number(campaign.academicYear.slice(5)) !== Number(campaign.academicYear.slice(0, 4)) + 1) {
      throw new Error(`Année universitaire invalide dans la campagne « ${campaign.id} ».`);
    }
    if (campaignYears.has(campaign.academicYear)) throw new Error(`Plusieurs campagnes existent pour ${campaign.academicYear}.`);
    campaignYears.add(campaign.academicYear);
    if (!['brouillon', 'ouverte', 'suspendue', 'cloturee'].includes(campaign.status)) {
      throw new Error(`Statut invalide pour la campagne « ${campaign.academicYear} ».`);
    }
    for (const field of ['startDate', 'endDate']) {
      const date = campaign[field];
      if (date != null && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00.000Z`)) || new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date)) {
        throw new Error(`Date « ${field} » invalide pour la campagne « ${campaign.academicYear} ».`);
      }
    }
    if (campaign.startDate && campaign.endDate && campaign.startDate > campaign.endDate) {
      throw new Error(`Les dates de la campagne « ${campaign.academicYear} » sont incohérentes.`);
    }
  }

  const studentById = new Map(students.map(student => [student.id, student]));
  const roomById = new Map(normalized.rooms.map(room => [room.id, room]));
  const dossierKeys = new Set();
  const dossierIds = new Set(normalized.housingDossiers.map(dossier => dossier.id));
  for (const dossier of normalized.housingDossiers) {
    requireString(dossier, 'studentId', 'housingDossiers');
    requireString(dossier, 'academicYear', 'housingDossiers');
    if (!studentById.has(dossier.studentId)) throw new Error(`Le résident du dossier « ${dossier.id} » est absent de la sauvegarde.`);
    const key = `${dossier.studentId}\u0000${dossier.academicYear}`;
    if (dossierKeys.has(key)) throw new Error(`Plusieurs dossiers existent pour le même résident et l’année ${dossier.academicYear}.`);
    dossierKeys.add(key);
    if (dossier.campaignId && !campaignIds.has(dossier.campaignId)) throw new Error(`La campagne du dossier « ${dossier.id} » est absente de la sauvegarde.`);
    for (const field of ['targetRoomId', 'assignedRoomId']) {
      if (dossier[field] && !roomById.has(dossier[field])) throw new Error(`La chambre « ${dossier[field]} » du dossier « ${dossier.id} » est absente de la sauvegarde.`);
    }
  }

  for (const event of normalized.renewalEvents) {
    requireString(event, 'campaignId', 'renewalEvents');
    requireString(event, 'type', 'renewalEvents');
    requireString(event, 'occurredAt', 'renewalEvents');
    requireString(event, 'actorId', 'renewalEvents');
    requireString(event, 'actorName', 'renewalEvents');
    if (!campaignIds.has(event.campaignId)) throw new Error(`La campagne de l’événement « ${event.id} » est absente de la sauvegarde.`);
    if (event.dossierId && !dossierIds.has(event.dossierId)) throw new Error(`Le dossier de l’événement « ${event.id} » est absent de la sauvegarde.`);
    if (event.studentId && !studentById.has(event.studentId)) throw new Error(`Le résident de l’événement « ${event.id} » est absent de la sauvegarde.`);
    for (const field of ['fromRoomId', 'toRoomId']) {
      if (event[field] && !roomById.has(event[field])) throw new Error(`La chambre de l’événement « ${event.id} » est absente de la sauvegarde.`);
    }
    if (!Number.isInteger(event.sequence) || event.sequence < 0) throw new Error(`Séquence invalide pour l’événement « ${event.id} ».`);
  }

  return normalized;
}

export function backupCollectionCounts(data) {
  return COLLECTIONS.reduce((counts, collection) => {
    counts[collection] = data[collection].length;
    return counts;
  }, {});
}
