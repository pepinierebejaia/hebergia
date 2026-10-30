const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function runWorker(scenario) {
  const { api } = require('../src/main/database');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'hebergia-renewal-'));
  const db = api(folder);
  const student = (id, roomId) => ({
    id, matricule: id, anneeBac: 2024, numeroInscription: id, nom: 'TEST', prenom: id,
    nomComplet: null, sexe: 'Garcon', nationalite: null, dateNaissance: '2000-01-01',
    lieuNaissance: null, filiere: 'Droit', faculte: 'Université', niveau: 'L2',
    telephone: '00000000', email: null, rue: '', commune: '', wilaya: '',
    statut: 'actif', chambreId: roomId, avatar: id === 'student-1' ? 'data:image/webp;base64,AAAA' : null
  });
  const seed = () => ({
    users: [
      { id: 'admin', username: 'admin', password: 'hash', name: 'Admin', phone: null, role: 'admin', bloc: null, active: true, avatar: null },
      { id: 'agent', username: 'agent', password: 'hash', name: 'Agent', phone: null, role: 'agent', bloc: 'Bloc A', active: true, avatar: null }
    ],
    students: [student('student-1', 'room-1'), student('student-2', 'room-2'), student('student-3', null), student('student-4', 'room-4')],
    rooms: [
      { id: 'room-1', bloc: 'Bloc A', numero: '101', capacite: 2, statut: 'normal' },
      { id: 'room-2', bloc: 'Bloc A', numero: '102', capacite: 1, statut: 'normal' },
      { id: 'room-3', bloc: 'Bloc A', numero: '103', capacite: 1, statut: 'normal' },
      { id: 'room-4', bloc: 'Bloc B', numero: '101', capacite: 2, statut: 'normal' }
    ],
    history: [], complaints: [], blocks: [{ id: 'block-a', name: 'Bloc A', ordre: 0, genre: 'mixte' }], floors: [],
    documentTemplates: [], documentTypes: [], academicRecords: [], housingDossiers: [],
    academicPeriods: [{ id: 'active', academicYear: '2026/2027', renewalsOpen: false, updatedAt: '2026-01-01T00:00:00.000Z' }],
    renewalCampaigns: [], renewalEvents: []
  });
  const openCampaign = () => {
    db.init(seed());
    const campaignId = 'renewal-2026/2027';
    db.updateRenewalCampaignDates({ campaignId, startDate: '2026-09-01', endDate: '2027-06-30' }, 'admin');
    db.setRenewalCampaignStatus(campaignId, 'ouverte', 'admin');
    return campaignId;
  };
  try {
    openCampaign();
    assert.equal(db.list('students', { excludePhotoData: true })[0].avatar, undefined);
    assert.equal(db.list('students')[0].avatar, 'data:image/webp;base64,AAAA');
    assert.equal(db.get('students', 'student-1').avatar, 'data:image/webp;base64,AAAA');
    if (scenario === 'backup-restore') {
      const restored = seed();
      db.replaceAll(restored);
      db.init(restored);
      assert.equal(db.list('students').length, 4);
      assert.equal(db.get('students', 'student-1').avatar, 'data:image/webp;base64,AAAA');
      assert.equal(db.list('housingDossiers').length, 4);
      assert.equal(db.list('renewalCampaigns').some(campaign => campaign.academicYear === '2026/2027'), true);
    } else if (scenario === 'assignment') {
      assert.throws(() => db.createRenewalCampaign({
        academicYear: '2027/2028', startDate: '2027-02-30', endDate: '2027-06-30'
      }, 'admin'), /date de début/i);
      assert.throws(() => db.createRenewalCampaign({
        academicYear: '2026/2027', startDate: '2027-09-01', endDate: '2028-06-30'
      }, 'admin'), /existe déjà/i);
      const dossierId = 'housing-student-1-2026/2027';
      db.updateRenewalDossier({ dossierId, status: 'accepte', notes: '' }, 'agent');
      db.setRenewalAssignment({ dossierId, roomId: 'room-1' }, 'agent');
      assert.equal(db.get('students', 'student-1').chambreId, 'room-1', 'proposed changes must leave the current room occupied');
      db.confirmRenewalAssignment(dossierId, 'agent');
      assert.equal(db.get('students', 'student-1').chambreId, 'room-1');
      assert.equal(db.get('housingDossiers', dossierId).assignmentAction, 'reconduite');
      assert.equal(db.list('history').length, 0);
      assert.throws(() => db.confirmRenewalAssignment(dossierId, 'agent'), /choisissez une chambre/i);
      db.setRenewalAssignment({ dossierId, roomId: 'room-3', reason: 'Motif vérifié' }, 'agent');
      db.confirmRenewalAssignment(dossierId, 'agent');
      assert.equal(db.get('students', 'student-1').chambreId, 'room-3');
      assert.equal(db.list('history').length, 1);
      assert.equal(db.list('history')[0].academicYear, '2026/2027');
      assert.equal(db.list('history')[0].fromRoomLabel, 'Bloc A 101');
      const secondDossier = 'housing-student-3-2026/2027';
      db.updateRenewalDossier({ dossierId: secondDossier, status: 'accepte', notes: '' }, 'admin');
      db.setRenewalAssignment({ dossierId: secondDossier, roomId: 'room-3' }, 'admin');
      assert.throws(() => db.confirmRenewalAssignment(secondDossier, 'admin'), /capacité atteinte/i);
      assert.equal(db.get('students', 'student-3').chambreId, null);
      assert.equal(db.get('students', 'student-1').chambreId, 'room-3');
    } else if (scenario === 'block-access') {
      const dossierId = 'housing-student-4-2026/2027';
      const agentSnapshot = db.renewalSnapshot('agent');
      assert.deepEqual(agentSnapshot.students.map(item => item.id), ['student-1', 'student-2']);
      assert.deepEqual(agentSnapshot.housingDossiers.map(item => item.studentId), ['student-1', 'student-2']);
      assert.equal(agentSnapshot.renewalEvents.some(event => event.studentId === 'student-4'), false);
      assert.equal(db.renewalSnapshot('admin').students.length, 4);
      const missingDossierId = 'housing-student-3-2026/2027';
      db.remove('housingDossiers', missingDossierId);
      assert.throws(() => db.ensureRenewalDossier('student-3', 'renewal-2026/2027', 'agent'), /hors de votre bloc/i);
      assert.equal(db.get('housingDossiers', missingDossierId), null);
      assert.equal(db.ensureRenewalDossier('student-3', 'renewal-2026/2027', 'admin').studentId, 'student-3');
      assert.throws(() => db.updateRenewalDossier({ dossierId, status: 'accepte', notes: '' }, 'agent'), /hors de votre bloc/i);
      db.updateRenewalDossier({ dossierId, status: 'accepte', notes: '' }, 'admin');
      assert.throws(() => db.setRenewalAssignment({ dossierId, roomId: 'room-4' }, 'agent'), /hors de votre bloc/i);
      db.setRenewalAssignment({ dossierId, roomId: 'room-4' }, 'admin');
      assert.throws(() => db.confirmRenewalAssignment(dossierId, 'agent'), /hors de votre bloc/i);
      db.confirmRenewalAssignment(dossierId, 'admin');
      assert.throws(() => db.recordRenewalKeyOperation({ dossierId, operation: 'remise' }, 'agent'), /hors de votre bloc/i);
      assert.throws(() => db.closeRenewalDossier(dossierId, 'agent'), /hors de votre bloc/i);
    } else if (scenario === 'keys') {
      const dossierId = 'housing-student-2-2026/2027';
      db.updateRenewalDossier({ dossierId, status: 'accepte', notes: '' }, 'agent');
      db.setRenewalAssignment({ dossierId, roomId: 'room-2' }, 'agent');
      db.confirmRenewalAssignment(dossierId, 'agent');
      assert.throws(() => db.recordRenewalKeyOperation({ dossierId, operation: 'remise' }, 'agent'), /déjà enregistrée/i);
      db.recordRenewalKeyOperation({ dossierId, operation: 'restitution' }, 'agent');
      assert.throws(() => db.recordRenewalKeyOperation({ dossierId, operation: 'restitution' }, 'agent'), /aucune remise préalable/i);
      db.recordRenewalKeyOperation({ dossierId, operation: 'remise' }, 'agent');
      assert.throws(() => db.recordRenewalKeyOperation({ dossierId, operation: 'remise' }, 'agent'), /déjà enregistrée/i);
      assert.deepEqual(db.list('renewalEvents').filter(event => event.studentId === 'student-2' && event.type.startsWith('cle_')).map(event => event.type), [
        'cle_restituee', 'cle_remise'
      ]);
    } else if (scenario === 'permissions-persistence') {
      assert.throws(() => db.setRenewalCampaignStatus('renewal-2026/2027', 'suspendue', 'agent'), /administrateur/i);
      const dossierId = 'housing-student-1-2026/2027';
      db.updateRenewalDossier({ dossierId, status: 'accepte', notes: 'Pièces vérifiées' }, 'agent');
      db.setRenewalAssignment({ dossierId, roomId: 'room-1' }, 'agent');
      db.confirmRenewalAssignment(dossierId, 'agent');
      db.closeRenewalDossier(dossierId, 'agent');
      assert.throws(() => db.closeRenewalDossier(dossierId, 'agent'), /déjà clôturé/i);
      db.close();
      const reopened = api(folder);
      reopened.init({});
      assert.equal(reopened.get('housingDossiers', dossierId).renewalStatus, 'cloture');
      assert.equal(reopened.list('renewalEvents').filter(event => event.dossierId === dossierId).length, 4);
      const installedDossier = 'housing-student-2-2026/2027';
      reopened.updateRenewalDossier({ dossierId: installedDossier, status: 'accepte', notes: '' }, 'agent');
      reopened.setRenewalAssignment({ dossierId: installedDossier, roomId: 'room-3' }, 'agent');
      assert.throws(() => reopened.closeRenewalDossier(installedDossier, 'agent'), /confirmez l’affectation/i);
      reopened.setRenewalAssignment({ dossierId: installedDossier, roomId: 'room-2' }, 'agent');
      reopened.closeRenewalDossier(installedDossier, 'agent');
      assert.equal(reopened.get('housingDossiers', installedDossier).assignmentStatus, 'confirmee');
      assert.equal(reopened.get('housingDossiers', installedDossier).assignmentAction, 'reconduite');
    } else {
      throw new Error(`Unknown test scenario: ${scenario}`);
    }
    process.stdout.write(`Renewal scenario passed: ${scenario}\n`);
  } finally {
    db.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--worker') {
  try {
    runWorker(process.argv[3]);
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exit(1);
  }
} else {
  for (const [scenario, title] of [
    ['backup-restore', 'complete backup replacement restores students, avatars, and renewal records'],
    ['block-access', 'agents cannot mutate renewal dossiers or rooms outside their block'],
    ['assignment', 'room retention, moves, full capacity, and duplicate campaigns'],
    ['keys', 'key handover, return, reissue, and double-operation prevention'],
    ['permissions-persistence', 'administrator permissions, closure, and persistence after restart']
  ]) {
    test(`renewal database validates ${title}`, () => {
      const result = spawnSync(process.execPath, [__filename, '--worker', scenario], {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 30000
      });
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, new RegExp(`Renewal scenario passed: ${scenario}`));
    });
  }
}
