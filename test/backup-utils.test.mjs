import test from 'node:test';
import assert from 'node:assert/strict';
import { backupCollectionCounts, validateBackupPayload } from '../src/renderer/backup-utils.mjs';

function validBackup() {
  return {
    version: 3,
    data: {
      users: [{ id: 'user-1' }],
      students: [{
        id: 'student-1',
        matricule: '2026001',
        nom: 'BENALI',
        prenom: 'Amine',
        anneeBac: 2026,
        statut: 'actif',
        chambreId: 'room-1'
      }],
      rooms: [{ id: 'room-1', bloc: 'Bloc A', numero: '101', capacite: 2, statut: 'normal' }],
      history: [],
      complaints: [],
      blocks: [],
      floors: []
    }
  };
}

test('backup validation accepts a complete backup and supplies omitted newer collections', () => {
  const data = validateBackupPayload(validBackup());

  assert.deepEqual(data.academicRecords, []);
  assert.deepEqual(data.housingDossiers, []);
  assert.deepEqual(data.academicPeriods, []);
  assert.deepEqual(data.renewalCampaigns, []);
  assert.deepEqual(data.renewalEvents, []);
  assert.equal(backupCollectionCounts(data).students, 1);
});

test('backup validation accepts a legacy unwrapped database object', () => {
  const { data } = validBackup();
  assert.equal(validateBackupPayload(data).students[0].matricule, '2026001');
});

test('backup validation rejects unsupported versions and missing required collections', () => {
  assert.throws(() => validateBackupPayload({ version: 99, data: {} }), /version.*pas prise en charge/i);
  assert.throws(() => validateBackupPayload({ data: { students: [] } }), /incomplète/i);
});

test('backup validation rejects duplicate identifiers and student matricules', () => {
  const duplicateId = validBackup();
  duplicateId.data.rooms.push({ ...duplicateId.data.rooms[0] });
  assert.throws(() => validateBackupPayload(duplicateId), /présent plusieurs fois/i);

  const duplicateMatricule = validBackup();
  duplicateMatricule.data.students.push({
    ...duplicateMatricule.data.students[0],
    id: 'student-2',
    matricule: ' 2026001 '
  });
  assert.throws(() => validateBackupPayload(duplicateMatricule), /matricule.*plusieurs fois/i);
});

test('backup validation rejects invalid capacities and missing assigned rooms', () => {
  const invalidCapacity = validBackup();
  invalidCapacity.data.rooms[0].capacite = 0;
  assert.throws(() => validateBackupPayload(invalidCapacity), /capacite.*invalide/i);

  const missingRoom = validBackup();
  missingRoom.data.students[0].chambreId = 'missing-room';
  assert.throws(() => validateBackupPayload(missingRoom), /chambre affectée.*absente/i);
});

test('backup validation checks campaigns, annual dossier uniqueness, and renewal event references', () => {
  const validCampaign = validBackup();
  validCampaign.version = 4;
  validCampaign.data.renewalCampaigns = [{
    id: 'renewal-2026/2027',
    academicYear: '2026/2027',
    startDate: '2026-09-01',
    endDate: '2027-06-30',
    status: 'ouverte'
  }];
  validCampaign.data.housingDossiers = [{
    id: 'housing-student-1-2026/2027',
    studentId: 'student-1',
    academicYear: '2026/2027',
    campaignId: 'renewal-2026/2027',
    targetRoomId: 'room-1'
  }];
  validCampaign.data.renewalEvents = [{
    id: 'event-1',
    campaignId: 'renewal-2026/2027',
    dossierId: 'housing-student-1-2026/2027',
    studentId: 'student-1',
    type: 'cle_remise',
    occurredAt: '2026-10-01T09:00:00.000Z',
    actorId: 'user-1',
    actorName: 'Administrateur',
    sequence: 1
  }];
  assert.equal(validateBackupPayload(validCampaign).renewalEvents.length, 1);

  const duplicateCampaign = structuredClone(validCampaign);
  duplicateCampaign.data.renewalCampaigns.push({
    ...duplicateCampaign.data.renewalCampaigns[0],
    id: 'campaign-duplicate'
  });
  assert.throws(() => validateBackupPayload(duplicateCampaign), /plusieurs campagnes/i);

  const duplicateDossier = structuredClone(validCampaign);
  duplicateDossier.data.housingDossiers.push({
    ...duplicateDossier.data.housingDossiers[0],
    id: 'housing-duplicate'
  });
  assert.throws(() => validateBackupPayload(duplicateDossier), /plusieurs dossiers/i);

  const missingCampaign = structuredClone(validCampaign);
  missingCampaign.data.renewalEvents[0].campaignId = 'campaign-missing';
  assert.throws(() => validateBackupPayload(missingCampaign), /campagne.*absente/i);
});
