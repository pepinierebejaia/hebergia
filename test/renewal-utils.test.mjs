import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRenewalCampaignRows, renewalDossierDisplayStatus, renewalKeyDisplayState, studentBelongsToRenewalBlock, summarizeRenewalCampaignRows } from '../src/renderer/renewal-utils.mjs';

test('agent renewal scope includes only residents assigned to their block', () => {
  const rooms = [
    { id: 'room-a', bloc: 'Bloc A' },
    { id: 'room-b', bloc: 'Bloc B' }
  ];
  assert.equal(studentBelongsToRenewalBlock({ chambreId: 'room-a' }, rooms, 'Bloc A'), true);
  assert.equal(studentBelongsToRenewalBlock({ chambreId: 'room-b' }, rooms, 'Bloc A'), false);
  assert.equal(studentBelongsToRenewalBlock({ chambreId: null }, rooms, 'Bloc A'), false);
});

test('campaign rows include active residents, scope agents to their block, and preserve academic records', () => {
  const campaign = { id: 'campaign-1', academicYear: '2026/2027', status: 'ouverte' };
  const students = [
    { id: 'one', statut: 'actif', chambreId: 'room-a' },
    { id: 'two', statut: 'actif', chambreId: 'room-b' },
    { id: 'inactive', statut: 'sorti', chambreId: 'room-a' },
    { id: 'unassigned', statut: 'actif', chambreId: null }
  ];
  const dossiers = [
    { studentId: 'one', campaignId: campaign.id, academicYear: campaign.academicYear, status: 'soumis' },
    { studentId: 'two', campaignId: campaign.id, academicYear: campaign.academicYear, status: 'accepte' }
  ];
  const academic = { studentId: 'one', academicYear: campaign.academicYear, niveau: 'L2' };
  const rows = buildRenewalCampaignRows({
    campaign,
    students,
    rooms: [{ id: 'room-a', bloc: 'Bloc A' }, { id: 'room-b', bloc: 'Bloc B' }],
    dossiers,
    academicRecords: [academic],
    isAdmin: false,
    block: 'Bloc A'
  });

  assert.deepEqual(rows, [
    { student: students[0], dossier: dossiers[0], academic }
  ]);
});

test('closed campaigns show residents with dossiers, including inactive residents', () => {
  const students = [
    { id: 'active', statut: 'actif', chambreId: 'room-a' },
    { id: 'inactive', statut: 'sorti', chambreId: 'room-a' },
    { id: 'without-dossier', statut: 'sorti', chambreId: 'room-a' }
  ];
  const dossiers = [
    { studentId: 'active', academicYear: '2025/2026' },
    { studentId: 'inactive', academicYear: '2025/2026' }
  ];

  const rows = buildRenewalCampaignRows({
    campaign: { id: 'closed', academicYear: '2025/2026', status: 'cloturee' },
    students,
    rooms: [{ id: 'room-a', bloc: 'Bloc A' }],
    dossiers,
    academicRecords: [],
    isAdmin: true,
    block: null
  });

  assert.deepEqual(rows.map(({ student }) => student.id), ['active', 'inactive']);
});

test('closing a campaign does not mark pending dossiers as renewed', () => {
  for (const status of ['a_renouveler', 'en_preparation', 'incomplet', 'soumis']) {
    assert.equal(renewalDossierDisplayStatus({ status }, 'cloturee'), 'clos_sans_decision');
  }
  assert.equal(renewalDossierDisplayStatus({ status: 'accepte' }, 'cloturee'), 'accepte');
  assert.equal(renewalDossierDisplayStatus({ status: 'a_renouveler' }, 'suspendue'), 'non_ouverte');
});

test('renewal campaign summaries reflect open and closed display states and assignment outcomes', () => {
  const rows = [
    { student: { id: 'submitted' }, dossier: { status: 'soumis' } },
    { student: { id: 'incomplete' }, dossier: { status: 'incomplet' } },
    { student: { id: 'accepted-retained' }, dossier: { status: 'accepte', assignmentAction: 'reconduite' } },
    { student: { id: 'accepted-moved' }, dossier: { status: 'accepte', assignmentStatus: 'confirmee', assignmentAction: 'modifiee' } },
    { student: { id: 'refused' }, dossier: { status: 'refuse' } },
    { student: { id: 'closed' }, dossier: { status: 'clos' } }
  ];

  const getAssignmentStatus = student =>
    student.id === 'accepted-retained' ? 'confirmee' : 'a_decider';

  assert.deepEqual(summarizeRenewalCampaignRows(rows, 'cloturee', getAssignmentStatus), {
    total: 5,
    pending: 0,
    accepted: 2,
    closedWithoutDecision: 2,
    incomplete: 0,
    refused: 1,
    retained: 1,
    changed: 1
  });
  assert.deepEqual(summarizeRenewalCampaignRows(rows, 'ouverte', getAssignmentStatus), {
    total: 5,
    pending: 2,
    accepted: 2,
    closedWithoutDecision: 0,
    incomplete: 1,
    refused: 1,
    retained: 1,
    changed: 1
  });
});

test('a key event after installation confirmation overrides inferred occupancy', () => {
  assert.equal(renewalKeyDisplayState({
    latest: { type: 'cle_restituee', occurredAt: '2026-10-02T10:00:00.000Z' },
    hasCurrentRoom: true,
    assignmentStatus: 'confirmee',
    assignmentConfirmedAt: '2026-10-01T10:00:00.000Z'
  }), 'restituee');
});

test('confirmed installation infers key handover until a later key event exists', () => {
  assert.equal(renewalKeyDisplayState({
    latest: null,
    hasCurrentRoom: false,
    assignmentStatus: 'confirmee',
    assignmentConfirmedAt: '2026-10-01T10:00:00.000Z'
  }), 'remise');
  assert.equal(renewalKeyDisplayState({
    latest: { type: 'cle_remise', occurredAt: '2026-09-30T10:00:00.000Z' },
    hasCurrentRoom: false,
    assignmentStatus: 'confirmee',
    assignmentConfirmedAt: '2026-10-01T10:00:00.000Z'
  }), 'remise');
});