const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hebergia', {
  db: {
    init: seed => ipcRenderer.invoke('db:init', seed),
    list: (collection, options) => ipcRenderer.invoke('db:list', collection, options),
    get: (collection, id) => ipcRenderer.invoke('db:get', { collection, id }),
    insert: (collection, document) => ipcRenderer.invoke('db:insert', { collection, document }),
    update: (collection, id, patch) => ipcRenderer.invoke('db:update', { collection, id, patch }),
    remove: (collection, id) => ipcRenderer.invoke('db:remove', { collection, id }),
    replaceAll: data => ipcRenderer.invoke('db:replaceAll', data),
    wipe: () => ipcRenderer.invoke('db:wipe')
  },
  renewals: {
    ensureDossier: (studentId, campaignId, actorId) => ipcRenderer.invoke('renewal:ensure-dossier', { studentId, campaignId, actorId }),
    getSnapshot: actorId => ipcRenderer.invoke('renewal:get-snapshot', { actorId }),
    createCampaign: (campaign, actorId) => ipcRenderer.invoke('renewal:create-campaign', { campaign, actorId }),
    updateCampaignDates: (campaignId, startDate, endDate, actorId) => ipcRenderer.invoke('renewal:update-campaign-dates', { campaignId, startDate, endDate, actorId }),
    setCampaignStatus: (campaignId, status, actorId) => ipcRenderer.invoke('renewal:set-campaign-status', { campaignId, status, actorId }),
    updateDossier: (dossierId, status, notes, academicData, actorId) => ipcRenderer.invoke('renewal:update-dossier', { dossierId, status, notes, academicData, actorId }),
    setAssignment: (dossierId, roomId, reason, actorId) => ipcRenderer.invoke('renewal:set-assignment', { dossierId, roomId, reason, actorId }),
    confirmAssignment: (dossierId, actorId) => ipcRenderer.invoke('renewal:confirm-assignment', { dossierId, actorId }),
    recordKeyOperation: (dossierId, operation, reason, actorId) => ipcRenderer.invoke('renewal:key-operation', { dossierId, operation, reason, actorId }),
    closeDossier: (dossierId, actorId) => ipcRenderer.invoke('renewal:close-dossier', { dossierId, actorId })
  },
  photos: {
    chooseStudentDirectory: () => ipcRenderer.invoke('photos:chooseStudentDirectory'),
    getStudentDirectory: () => ipcRenderer.invoke('photos:getStudentDirectory'),
    readStudentAvatar: registrationNumber => ipcRenderer.invoke('photos:readStudentAvatar', registrationNumber),
    saveStudentAvatar: (registrationNumber, dataUrl) => ipcRenderer.invoke('photos:saveStudentAvatar', registrationNumber, dataUrl)
  }
});
