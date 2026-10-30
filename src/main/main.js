const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron');
const { createReadStream } = require('node:fs');
const { constants: fsConstants } = require('node:fs');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { api } = require('./database');

let database;
let studentPhotoDirectoryPromise;
const APP_VERSION = app.getVersion();
const STUDENT_PHOTO_TYPES = new Map([
  ['.webp', 'image/webp'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png']
]);
const MAX_STUDENT_PHOTO_SIZE = 10 * 1024 * 1024;

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function assetPath(name) {
  return path.join(app.getAppPath(), 'assets', name);
}

function defaultStudentPhotoDirectory() {
  return path.join(app.getPath('pictures'), 'Hebergia-Photos');
}

async function movePhotoEntry(source, destination) {
  const sourceStat = await fs.lstat(source);
  try {
    await fs.lstat(destination);
    if (sourceStat.isDirectory()) {
      const destinationStat = await fs.lstat(destination);
      if (destinationStat.isDirectory()) return movePhotoDirectoryContents(source, destination);
    }
    return { moved: 0, skipped: 1 };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  try {
    await fs.rename(source, destination);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    if (sourceStat.isDirectory()) {
      await fs.mkdir(destination);
      const result = await movePhotoDirectoryContents(source, destination);
      if (!(await fs.readdir(source)).length) await fs.rmdir(source);
      return result;
    }
    if (sourceStat.isSymbolicLink()) {
      await fs.symlink(await fs.readlink(source), destination);
    } else {
      await fs.copyFile(source, destination, fsConstants.COPYFILE_EXCL);
    }
    await fs.rm(source);
  }
  return { moved: 1, skipped: 0 };
}

async function movePhotoDirectoryContents(source, destination) {
  let moved = 0;
  let skipped = 0;
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const result = await movePhotoEntry(path.join(source, entry.name), path.join(destination, entry.name));
    moved += result.moved;
    skipped += result.skipped;
  }
  return { moved, skipped };
}

async function ensureStudentPhotoDirectory() {
  const directory = defaultStudentPhotoDirectory();
  await fs.mkdir(directory, { recursive: true });
  return directory;
}

function registerDatabaseHandlers() {
  database = api(app.getPath('userData'));
  ipcMain.handle('db:init', async (_event, seed) => {
    const realmPath = path.join(app.getPath('userData'), 'hebergia.realm');
    const backupPath = `${realmPath}.pre-renewal-v15.bak`;
    const checksumPath = `${backupPath}.sha256`;
    let sourceStat;
    try {
      sourceStat = await fs.stat(realmPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (sourceStat) {
      let createdBackup = false;
      try {
        await fs.copyFile(realmPath, backupPath, fsConstants.COPYFILE_EXCL);
        createdBackup = true;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      if (createdBackup) {
        const backupStat = await fs.stat(backupPath);
        const [sourceHash, backupHash] = await Promise.all([sha256File(realmPath), sha256File(backupPath)]);
        if (backupStat.size !== sourceStat.size || sourceHash !== backupHash) throw new Error('La sauvegarde préalable de la base Realm n’a pas été vérifiée correctement.');
        await fs.writeFile(checksumPath, `${backupHash}\n`, { flag: 'wx' });
      } else {
        const expectedHash = (await fs.readFile(checksumPath, 'utf8')).trim();
        if (!/^[a-f0-9]{64}$/.test(expectedHash) || await sha256File(backupPath) !== expectedHash) {
          throw new Error('La sauvegarde préalable de la base Realm est absente ou invalide; la migration est interrompue.');
        }
      }
    }
    return database.init(seed);
  });
  ipcMain.handle('db:list', (_event, collection, options) => database.list(collection, options));
  ipcMain.handle('db:get', (_event, { collection, id }) => database.get(collection, id));
  ipcMain.handle('db:insert', (_event, { collection, document }) => database.insert(collection, document));
  ipcMain.handle('db:update', (_event, { collection, id, patch }) => database.update(collection, id, patch));
  ipcMain.handle('db:remove', (_event, { collection, id }) => database.remove(collection, id));
  ipcMain.handle('db:replaceAll', (_event, data) => database.replaceAll(data));
  ipcMain.handle('db:wipe', () => database.wipe());
  ipcMain.handle('renewal:create-campaign', (_event, { campaign, actorId }) => database.createRenewalCampaign(campaign, actorId));
  ipcMain.handle('renewal:ensure-dossier', (_event, { studentId, campaignId, actorId }) => database.ensureRenewalDossier(studentId, campaignId, actorId));
  ipcMain.handle('renewal:get-snapshot', (_event, { actorId }) => database.renewalSnapshot(actorId));
  ipcMain.handle('renewal:update-campaign-dates', (_event, { campaignId, startDate, endDate, actorId }) => database.updateRenewalCampaignDates({ campaignId, startDate, endDate }, actorId));
  ipcMain.handle('renewal:set-campaign-status', (_event, { campaignId, status, actorId }) => database.setRenewalCampaignStatus(campaignId, status, actorId));
  ipcMain.handle('renewal:update-dossier', (_event, { dossierId, status, notes, academicData, actorId }) => database.updateRenewalDossier({ dossierId, status, notes, academicData }, actorId));
  ipcMain.handle('renewal:set-assignment', (_event, { dossierId, roomId, reason, actorId }) => database.setRenewalAssignment({ dossierId, roomId, reason }, actorId));
  ipcMain.handle('renewal:confirm-assignment', (_event, { dossierId, actorId }) => database.confirmRenewalAssignment(dossierId, actorId));
  ipcMain.handle('renewal:key-operation', (_event, { dossierId, operation, reason, actorId }) => database.recordRenewalKeyOperation({ dossierId, operation, reason }, actorId));
  ipcMain.handle('renewal:close-dossier', (_event, { dossierId, actorId }) => database.closeRenewalDossier(dossierId, actorId));
  ipcMain.handle('photos:chooseStudentDirectory', async event => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const options = { properties: ['openDirectory'] };
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled) return null;
    const directory = path.resolve(result.filePaths[0]);
    const defaultDirectory = path.resolve(defaultStudentPhotoDirectory());
    await ensureStudentPhotoDirectory();
    const directoryConfigPath = path.join(app.getPath('userData'), 'student-photo-directory.txt');
    const currentCustomDirectory = await fs.readFile(directoryConfigPath, 'utf8').then(value => value.trim()).catch(error => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    const normalized = value => process.platform === 'win32' ? value.toLowerCase() : value;
    const isDefaultDirectory = !currentCustomDirectory || normalized(path.resolve(currentCustomDirectory)) === normalized(defaultDirectory);
    if (normalized(directory) === normalized(defaultDirectory)) {
      await fs.rm(directoryConfigPath, { force: true });
      studentPhotoDirectoryPromise = Promise.resolve(defaultDirectory);
      return { directory: defaultDirectory, moved: 0, skipped: 0 };
    }

    let migration = { moved: 0, skipped: 0 };
    if (isDefaultDirectory && normalized(directory) !== normalized(defaultDirectory)) {
      const relativeDestination = path.relative(defaultDirectory, directory);
      if (relativeDestination && !relativeDestination.startsWith(`..${path.sep}`) && relativeDestination !== '..' && !path.isAbsolute(relativeDestination)) {
        throw new Error('Choisissez un dossier différent, et non un sous-dossier du dossier de photos par défaut.');
      }
      migration = await movePhotoDirectoryContents(defaultDirectory, directory);
    }
    await fs.writeFile(directoryConfigPath, directory, 'utf8');
    studentPhotoDirectoryPromise = Promise.resolve(directory);
    return { directory, ...migration };
  });
  ipcMain.handle('photos:getStudentDirectory', () => getStudentPhotoDirectory());
  ipcMain.handle('photos:readStudentAvatar', (_event, registrationNumber) => readStudentAvatar(registrationNumber));
  ipcMain.handle('photos:saveStudentAvatar', (_event, registrationNumber, dataUrl) => saveStudentAvatar(registrationNumber, dataUrl));
}

async function getStudentPhotoDirectory() {
  if (!studentPhotoDirectoryPromise) {
    studentPhotoDirectoryPromise = fs.readFile(path.join(app.getPath('userData'), 'student-photo-directory.txt'), 'utf8')
      .then(directory => directory.trim())
      .catch(error => {
        if (error.code === 'ENOENT') return ensureStudentPhotoDirectory();
        throw error;
      });
  }
  return studentPhotoDirectoryPromise;
}

async function readStudentAvatar(registrationNumber) {
  const number = String(registrationNumber ?? '').trim();
  if (!/^[\p{L}\p{N}_-]+$/u.test(number)) throw new Error('Numéro d’inscription invalide.');
  const directory = await getStudentPhotoDirectory();
  if (!directory) return null;

  const files = new Set(await fs.readdir(directory));
  let filename;
  let mimeType;
  for (const [extension, type] of STUDENT_PHOTO_TYPES) {
    const candidate = [...files].find(file =>
      path.parse(file).name === number && path.extname(file).toLowerCase() === extension
    );
    if (candidate) {
      filename = candidate;
      mimeType = type;
      break;
    }
  }
  if (!filename) return null;

  const filePath = path.join(directory, filename);
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_STUDENT_PHOTO_SIZE) throw new Error('La photo du résident dépasse la taille maximale de 10 Mo.');
  const image = await fs.readFile(filePath);
  return `data:${mimeType};base64,${image.toString('base64')}`;
}

async function saveStudentAvatar(registrationNumber, dataUrl) {
  const number = String(registrationNumber ?? '').trim();
  if (!/^[\p{L}\p{N}_-]+$/u.test(number)) throw new Error('Numéro d’inscription invalide.');
  const match = /^data:image\/webp;base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(dataUrl ?? ''));
  if (!match) throw new Error('Format de photo invalide. Veuillez sélectionner une image.');
  const image = Buffer.from(match[1], 'base64');
  if (!image.length || image.length > MAX_STUDENT_PHOTO_SIZE) throw new Error('La photo doit faire moins de 10 Mo.');

  const directory = await getStudentPhotoDirectory();
  if (!directory) throw new Error('Choisissez d’abord un dossier pour les photos dans Paramètres > Général.');
  const directoryStat = await fs.stat(directory);
  if (!directoryStat.isDirectory()) throw new Error('Le dossier des photos sélectionné est introuvable.');

  const filename = `${number}.webp`;
  await fs.writeFile(path.join(directory, filename), image);
  return filename;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    icon: assetPath('icon.png'),
    backgroundColor: '#eef1ee',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'));
  win.setMenuBarVisibility(false);
  return win;
}

function createSplashWindow() {
  const splash = new BrowserWindow({
    width: 1000,
    height: 590,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#f7fbff',
    icon: assetPath('icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  splash.loadFile(path.join(__dirname, 'splash.html'), {
    query: { version: APP_VERSION, developer: 'ABDULKARIM' }
  });
  return splash;
}

function launchWithSplash() {
  const win = createWindow();
  const splash = createSplashWindow();
  let splashShown = false;
  splash.once('ready-to-show', () => { splashShown = true; splash.show(); });
  setTimeout(() => {
    // destroy() bypasses the window's closable flag and guarantees that a
    // stalled splash renderer cannot keep the application trapped forever.
    if (!splash.isDestroyed()) splash.destroy();
    if (!win.isDestroyed()) win.show();
  }, 5000);
  setTimeout(() => { if (!splashShown && !splash.isDestroyed()) splash.show(); }, 250);
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  launchWithSplash();
  ensureStudentPhotoDirectory().catch(error => console.error('Unable to create the default student photos folder:', error));
  // Start the splash timer before opening Realm. A slow or damaged local
  // database must never prevent the splash fail-safe from running.
  registerDatabaseHandlers();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) launchWithSplash();
  });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { database?.close(); });
