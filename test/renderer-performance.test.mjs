import test from 'node:test';
import assert from 'node:assert/strict';
import { createOccupancyIndex, createSnapshotScope, paginateItems, summarizeMonthlyMovements } from '../src/renderer/performance-utils.mjs';

test('snapshot scope shares one snapshot in a render cycle and reloads for the next', async () => {
  let reads = 0;
  const scope = createSnapshotScope(async () => ({ read: ++reads }));

  const firstCycle = await scope.run(async firstSnapshot => {
    assert.equal(await scope.get(), firstSnapshot);
    return scope.run(async nestedSnapshot => nestedSnapshot);
  });
  const secondCycle = await scope.run(async currentSnapshot => currentSnapshot);

  assert.deepEqual(firstCycle, { read: 1 });
  assert.deepEqual(secondCycle, { read: 2 });
  assert.equal(reads, 2);
});

test('snapshot scope releases a failed snapshot so later renders can retry', async () => {
  let reads = 0;
  const scope = createSnapshotScope(async () => {
    reads += 1;
    if (reads === 1) throw new Error('snapshot unavailable');
    return { read: reads };
  });

  await assert.rejects(scope.run(async () => {}), /snapshot unavailable/);
  assert.deepEqual(await scope.run(async snapshot => snapshot), { read: 2 });
});

test('overlapping render cycles share the snapshot until both have completed', async () => {
  let reads = 0;
  let releaseFirstRun;
  const firstRunGate = new Promise(resolve => { releaseFirstRun = resolve; });
  const scope = createSnapshotScope(async () => ({ read: ++reads }));

  const firstRun = scope.run(async snapshot => {
    await firstRunGate;
    return snapshot;
  });
  await Promise.resolve();
  const secondRun = await scope.run(async snapshot => snapshot);
  const stillActive = await scope.get();

  assert.deepEqual(secondRun, { read: 1 });
  assert.equal(stillActive, secondRun);
  assert.equal(reads, 1);
  releaseFirstRun();
  assert.equal(await firstRun, secondRun);
  assert.deepEqual(await scope.run(async snapshot => snapshot), { read: 2 });
});

test('occupancy index groups only active students by assigned room', () => {
  const students = [
    { id: 'one', chambreId: 'room-1', statut: 'actif' },
    { id: 'two', chambreId: 'room-1', statut: 'actif' },
    { id: 'inactive', chambreId: 'room-1', statut: 'sorti' },
    { id: 'unassigned', chambreId: null, statut: 'actif' }
  ];
  const index = createOccupancyIndex(students);

  assert.deepEqual(index.get('room-1'), students.slice(0, 2));
  assert.equal(index.has('room-2'), false);
});

test('pagination returns bounded slices and accurate row ranges', () => {
  const result = paginateItems(Array.from({ length: 53 }, (_, index) => index + 1), 2, 25);

  assert.deepEqual(result, {
    items: Array.from({ length: 25 }, (_, index) => index + 26),
    page: 2,
    pageCount: 3,
    start: 25,
    end: 50,
    total: 53
  });
});

test('pagination clamps out-of-range pages and handles an empty list', () => {
  assert.deepEqual(paginateItems([1, 2, 3], 9, 2), {
    items: [3],
    page: 2,
    pageCount: 2,
    start: 2,
    end: 3,
    total: 3
  });
  assert.deepEqual(paginateItems([], 4, 25), {
    items: [],
    page: 1,
    pageCount: 0,
    start: 0,
    end: 0,
    total: 0
  });
});

test('pagination normalizes invalid page and page-size inputs', () => {
  assert.deepEqual(paginateItems([1, 2, 3], Number.NaN, 0), {
    items: [1],
    page: 1,
    pageCount: 3,
    start: 0,
    end: 1,
    total: 3
  });
});

test('monthly movement summary filters to the selected recent calendar months', () => {
  const months = summarizeMonthlyMovements([
    { date: '2026-07-15T12:00:00Z', type: 'entree' },
    { date: '2026-08-15T12:00:00Z', type: 'entree' },
    { date: '2026-08-20T12:00:00Z', type: 'sortie' },
    { date: '2026-09-15T12:00:00Z', type: 'transfert' },
    { date: '2026-10-15T12:00:00Z', type: 'sortie' },
    { date: 'invalid', type: 'entree' },
    { date: '2026-10-15T12:00:00Z', type: 'unknown' }
  ], new Date('2026-10-15T12:00:00Z'), 3);

  assert.deepEqual(months.map(({ key, entree, sortie, transfert, net }) => ({
    key, entree, sortie, transfert, net
  })), [
    { key: '2026-08', entree: 1, sortie: 1, transfert: 0, net: 0 },
    { key: '2026-09', entree: 0, sortie: 0, transfert: 1, net: 0 },
    { key: '2026-10', entree: 0, sortie: 1, transfert: 0, net: -1 }
  ]);
});

test('monthly movement summary clamps long periods and rejects invalid dates', () => {
  const months = summarizeMonthlyMovements([], new Date('2026-10-15T12:00:00Z'), 99);

  assert.equal(months.length, 12);
  assert.equal(months[0].key, '2025-11');
  assert.equal(months.at(-1).key, '2026-10');
  assert.throws(() => summarizeMonthlyMovements([], 'invalid-date', 6), RangeError);
});
