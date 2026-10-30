export const RENEWAL_PENDING_STATUSES = ['a_renouveler', 'en_preparation', 'incomplet', 'soumis'];

export function studentBelongsToRenewalBlock(student, rooms, block) {
  return Boolean(block) && rooms.some(room => room.id === student?.chambreId && room.bloc === block);
}

export function buildRenewalCampaignRows({
  campaign,
  students,
  rooms,
  dossiers,
  academicRecords,
  isAdmin,
  block
}) {
  const campaignDossiers = dossiers.filter(item =>
    item.campaignId === campaign.id || item.academicYear === campaign.academicYear
  );
  const dossierByStudent = new Map(campaignDossiers.map(item => [item.studentId, item]));
  const campaignStudents = campaign.status === 'cloturee'
    ? students.filter(student => dossierByStudent.has(student.id))
    : students.filter(student => student.statut === 'actif');

  return campaignStudents
    .filter(student => isAdmin || studentBelongsToRenewalBlock(student, rooms, block))
    .map(student => ({
      student,
      dossier: dossierByStudent.get(student.id) || null,
      academic: academicRecords.find(record =>
        record.studentId === student.id && record.academicYear === campaign.academicYear
      )
    }));
}

export function renewalDossierDisplayStatus(dossier, campaignStatus) {
  const status = dossier?.status || 'a_renouveler';
  if (campaignStatus === 'cloturee' && RENEWAL_PENDING_STATUSES.includes(status)) return 'clos_sans_decision';
  if (status === 'a_renouveler' && campaignStatus !== 'ouverte') return 'non_ouverte';
  return status;
}

export function summarizeRenewalCampaignRows(rows, campaignStatus, getAssignmentStatus) {
  const activeRows = rows.filter(row => (row.dossier?.status || 'a_renouveler') !== 'clos');
  const getDisplayStatus = row => renewalDossierDisplayStatus(row.dossier, campaignStatus);

  return {
    total: activeRows.length,
    pending: activeRows.filter(row => RENEWAL_PENDING_STATUSES.includes(getDisplayStatus(row))).length,
    accepted: activeRows.filter(({ dossier }) => dossier?.status === 'accepte').length,
    closedWithoutDecision: activeRows.filter(row => getDisplayStatus(row) === 'clos_sans_decision').length,
    incomplete: activeRows.filter(row => getDisplayStatus(row) === 'incomplet').length,
    refused: activeRows.filter(({ dossier }) => dossier?.status === 'refuse').length,
    retained: activeRows.filter(({ student, dossier }) =>
      getAssignmentStatus(student, dossier) === 'confirmee'
        && (dossier?.assignmentAction === 'reconduite' || dossier?.assignmentStatus !== 'confirmee')
    ).length,
    changed: activeRows.filter(({ dossier }) =>
      dossier?.assignmentStatus === 'confirmee' && dossier.assignmentAction === 'modifiee'
    ).length
  };
}

export function renewalKeyDisplayState({ latest, hasCurrentRoom, assignmentStatus, assignmentConfirmedAt }) {
  if (latest && assignmentConfirmedAt && latest.occurredAt >= assignmentConfirmedAt) {
    return latest.type === 'cle_remise' ? 'remise' : 'restituee';
  }

  const installationHandover = assignmentStatus === 'confirmee'
    && (!latest || (assignmentConfirmedAt
      ? latest.occurredAt < assignmentConfirmedAt
      : latest.type === 'cle_remise'));
  if (installationHandover || hasCurrentRoom) return 'remise';
  if (latest) return latest.type === 'cle_remise' ? 'remise' : 'restituee';
  return 'non_remise';
}