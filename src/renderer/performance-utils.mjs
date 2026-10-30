export function createSnapshotScope(loadSnapshot) {
  let activeSnapshot;
  let activeRuns = 0;

  return {
    get() {
      return activeSnapshot || loadSnapshot();
    },
    async run(work) {
      if (!activeSnapshot) activeSnapshot = Promise.resolve().then(loadSnapshot);
      activeRuns += 1;
      try {
        return await work(await activeSnapshot);
      } finally {
        activeRuns -= 1;
        if (activeRuns === 0) activeSnapshot = null;
      }
    }
  };
}

export function createOccupancyIndex(students) {
  const occupantsByRoom = new Map();
  for (const student of students) {
    if (student.statut !== 'actif' || !student.chambreId) continue;
    const occupants = occupantsByRoom.get(student.chambreId);
    if (occupants) occupants.push(student);
    else occupantsByRoom.set(student.chambreId, [student]);
  }
  return occupantsByRoom;
}

export function paginateItems(items, requestedPage, pageSize) {
  const size = Number.isFinite(Number(pageSize)) ? Math.max(1, Math.floor(Number(pageSize))) : 1;
  const requested = Number.isFinite(Number(requestedPage)) ? Math.floor(Number(requestedPage)) : 1;
  const total = items.length;
  const pageCount = Math.ceil(total / size);
  const page = Math.min(Math.max(1, requested), Math.max(1, pageCount));
  const start = total === 0 ? 0 : (page - 1) * size;

  return {
    items: items.slice(start, start + size),
    page,
    pageCount,
    start,
    end: Math.min(start + size, total),
    total
  };
}

export function summarizeMonthlyMovements(records, now = new Date(), requestedMonths = 6) {
  const months = Number.isFinite(Number(requestedMonths))
    ? Math.min(12, Math.max(1, Math.floor(Number(requestedMonths))))
    : 6;
  const currentDate = new Date(now);
  if (Number.isNaN(currentDate.getTime())) throw new RangeError('A valid date is required.');

  const monthStarts = Array.from({ length: months }, (_, index) =>
    new Date(currentDate.getFullYear(), currentDate.getMonth() - (months - index - 1), 1)
  );
  const movements = monthStarts.map(month => {
    const year = month.getFullYear();
    const monthIndex = month.getMonth();
    return {
      key: `${year}-${String(monthIndex + 1).padStart(2, '0')}`,
      label: new Date(Date.UTC(year, monthIndex, 1)).toLocaleDateString('fr-FR', {
        month: 'short',
        timeZone: 'UTC'
      }),
      entree: 0,
      sortie: 0,
      transfert: 0,
      net: 0
    };
  });
  const monthByKey = new Map(movements.map(month => [month.key, month]));

  for (const record of records) {
    const date = new Date(record.date);
    if (Number.isNaN(date.getTime()) || !['entree', 'sortie', 'transfert'].includes(record.type)) continue;
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    const month = monthByKey.get(key);
    if (month) {
      month[record.type] += 1;
      if (record.type === 'entree') month.net += 1;
      if (record.type === 'sortie') month.net -= 1;
    }
  }

  return movements;
}
