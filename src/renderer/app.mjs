'use strict';
import { createOccupancyIndex, createSnapshotScope, paginateItems, summarizeMonthlyMovements } from './performance-utils.mjs';
import { RENEWAL_PENDING_STATUSES, buildRenewalCampaignRows, renewalDossierDisplayStatus, renewalKeyDisplayState, studentBelongsToRenewalBlock, summarizeRenewalCampaignRows } from './renewal-utils.mjs';
import { backupCollectionCounts, validateBackupPayload } from './backup-utils.mjs';
import { hashPassword, verifyPassword } from './password-utils.mjs';


/* ══════════════ SECTION 0 — CONSTANTES ══════════════ */
const NIVEAUX = ['L1','L2','L3','M1','M2','Doctorat'];
const TYPES_REC = [['plomberie','Plomberie'],['electricite','Électricité'],['mobilier','Mobilier'],['autre','Autre']];
const TYPE_COLORS = { plomberie:'#2e6f8e', electricite:'#d8a03d', mobilier:'#0f5e54', autre:'#8a6a4f' };
const PRIORITES = [['basse','Basse'],['moyenne','Moyenne'],['haute','Haute']];
const REC_STATUTS = [['nouvelle','Nouvelle'],['en_cours','En cours'],['resolue','Résolue'],['rejetee','Rejetée']];
const VIEWS = {
  dashboard:['Tableau de bord','Vue d\u2019ensemble de la résidence'],
  students:['Résidents','Fiches, recherche et affectations'],
  'renewal-tracking':['Suivi des renouvellements','Gestion des dossiers annuels de résidence'],
  'student-detail':['Fiche étudiant','Détails et parcours du résident'],
  rooms:['Blocs / Chambres','Parc de chambres par bloc'],
  history:['Historique d\u2019affectation','Entrées, sorties et transferts'],
  reports:['Rapports','Statistiques détaillées de la résidence'],
  settings:['Paramètres','Préférences de l’application'],
  templates:['Modèles de documents','Modèles réutilisables d’attestations et convocations'],
  import:['Importer les données','Importer des fichiers Excel, CSV ou JSON'],
};

/* ══════════════ SECTION 1 — UTILITAIRES GÉNÉRAUX ══════════════ */
const $ = id => document.getElementById(id);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(36).slice(2) + Date.now());
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const nowISO = () => new Date().toISOString();
const fmtDate = iso => {
  if (!iso) return '—';
  const dateOnly = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) return `${dateOnly[3]}/${dateOnly[2]}/${dateOnly[1]}`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('fr-FR',{day:'2-digit',month:'2-digit',year:'numeric'}).format(date);
};
const parseDisplayDate = value => {
  if (!value) return '';
  const match = String(value).trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  const [, dayText, monthText, yearText] = match;
  const day = Number(dayText), month = Number(monthText), year = Number(yearText);
  if (month < 1 || month > 12 || day < 1 || day > new Date(year, month, 0).getDate()) return null;
  return `${yearText}-${monthText}-${dayText}`;
};
const dateInputValue = iso => {
  const match = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : '';
};
const academicYearFor = value => {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return null;
  const year = date.getFullYear(), month = date.getMonth(), day = date.getDate();
  if (month >= 8) return `${year}/${year+1}`;
  if (month < 6 || (month === 6 && day <= 15)) return `${year-1}/${year}`;
  return null;
};
const activeAcademicPeriod={year:null,renewalsOpen:false,campaignId:null,campaignStatus:'brouillon'};
const calendarAcademicYear = (value=nowISO()) => {
  const date=new Date(value);
  if(Number.isNaN(date.getTime())) throw AppError('Date invalide pour déterminer l’année universitaire.');
  const year=date.getFullYear(),start=date.getMonth()>=8?year:year-1;
  return `${start}/${start+1}`;
};
const currentAcademicYear = (value=nowISO()) => activeAcademicPeriod.year||calendarAcademicYear(value);
const nextAcademicLevel = level => {
  const normalized=String(level||'').trim();
  const levels=['L1','L2','L3','M1','M2','Doctorat'];
  const index=levels.findIndex(item=>item.toLowerCase()===normalized.toLowerCase());
  if(index>=0) return levels[Math.min(index+1,levels.length-1)];
  const numbered=normalized.match(/^(.*?)(\d+)$/);
  return numbered?`${numbered[1]}${Number(numbered[2])+1}`:normalized;
};
const fmtDateTime = iso => iso ? fmtDate(iso) + ' · ' +
  new Date(iso).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'}) : '—';
const fmtTime = iso => new Date(iso).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'});
const initials = name => name.split(/\s+/).map(w=>w[0]).filter(Boolean).slice(0,2).join('').toUpperCase();
const academicResultVisible = (academicYear,date=new Date()) => {
  const start=academicYearStart(academicYear);
  if(start===null) return false;
  const revealDate=new Date(start+1,5,15);
  return date>=revealDate;
};
function setUserAvatar(el,user){ const value=String(user?.avatar||'').trim(); if(value.startsWith('data:image/')){ el.classList.add('has-image'); el.innerHTML=`<img src="${value}" alt="Avatar">`; } else { el.classList.remove('has-image'); el.textContent=value||initials(user?.name||''); } }
function residenceGenderType(){
  const type=localStorage.getItem('hebergia_residence_type')||'mixte';
  return ['fille','garcon','mixte'].includes(type)?type:'mixte';
}
function isResidenceGenderCompatible(student,type=residenceGenderType()){
  return type==='mixte'||residentGender(student?.sexe)===type;
}
function assertResidenceGenderCompatible(student,type=residenceGenderType()){
  if(type==='mixte') return;
  const gender=residentGender(student?.sexe);
  const label=type==='fille'?'filles':'garçons';
  if(!gender) throw AppError(`Le sexe de ${student?.prenom||'ce résident'} ${student?.nom||''} doit être renseigné avant son admission dans une résidence réservée aux ${label}.`);
  if(gender!==type) throw AppError(`Admission impossible : ${student?.prenom||'ce résident'} ${student?.nom||''} ne peut pas être admis dans une résidence réservée aux ${label}.`);
}
function assertResidenceTypeCompatible(type,students){
  if(!['fille','garcon','mixte'].includes(type)) throw AppError('Choisissez un type de résidence valide.');
  if(type==='mixte') return;
  const incompatible=students.find(student=>student.statut==='actif'&&!isResidenceGenderCompatible(student,type));
  if(incompatible) assertResidenceGenderCompatible(incompatible,type);
}
function bindResidenceTypeSetting(select){
  select.value=residenceGenderType();
  select.addEventListener('change',async()=>{
    const type=select.value;
    try{
      const snap=await snapshot();
      assertResidenceTypeCompatible(type,snap.students);
      localStorage.setItem('hebergia_residence_type',type);
      applyPreferences();
      await refresh();
    }catch(err){
      select.value=residenceGenderType();
      toast(err.message||'Erreur inattendue','error');
    }
  });
}
function studentGenderClass(sexe){
  if(residenceGenderType()!=='mixte') return 'gender-neutral';
  const gender=String(sexe||'').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  return gender==='garcon'?'gender-boy':gender==='fille'?'gender-girl':'gender-neutral';
}
function residentGender(sexe){
  const gender=String(sexe||'').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z]/g,'');
  if(['f','femme','feminin','feminine','female','fille','filles','woman','women'].includes(gender)) return 'fille';
  if(['m','h','homme','masculin','masculine','male','garcon','garcons','man','men'].includes(gender)) return 'garcon';
  return '';
}
function normalizeBlockGender(genre){
  const value=String(genre||'').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z]/g,'').replace(/^reservee?aux/,'');
  if(['fille','filles','feminin','feminine','female'].includes(value)) return 'fille';
  if(['garcon','garcons','masculin','masculine','male'].includes(value)) return 'garcon';
  return 'mixte';
}
function blockGender(snap,bloc){
  const name=String(bloc||'').trim().toLocaleLowerCase('fr');
  return normalizeBlockGender((snap.blocks||[]).find(item=>String(item.name||'').trim().toLocaleLowerCase('fr')===name)?.genre);
}
function blockGenderLabel(genre){ return genre==='fille'?'Filles':genre==='garcon'?'Garçons':'Mixte'; }
function isBlockGenderCompatible(snap,student,room){
  if(!isResidenceGenderCompatible(student)) return false;
  const genre=blockGender(snap,room.bloc);
  return genre==='mixte'||residentGender(student?.sexe)===genre;
}
function assertBlockGenderCompatible(snap,student,room){
  assertResidenceGenderCompatible(student);
  const genre=blockGender(snap,room.bloc);
  if(genre==='mixte') return;
  const gender=residentGender(student?.sexe);
  if(!gender) throw AppError(`Le sexe de ${student?.prenom||'ce résident'} ${student?.nom||''} doit être renseigné avant de l’affecter au Bloc ${blockGenderLabel(genre).toLowerCase()}.`);
  if(gender!==genre) throw AppError(`Affectation impossible : ${student?.prenom||'ce résident'} ${student?.nom||''} ne peut pas être affecté au Bloc ${blockGenderLabel(genre).toLowerCase()}.`);
}
function studentAvatarMarkup(student,clickable=false){
  const photo=String(student?.avatar||'').trim();
  const genderClass=studentGenderClass(student?.sexe);
  const registrationNumber=String(student?.numeroInscription||(student?.matricule?`${student?.anneeBac||2025}${student.matricule}`:'')).trim();
  const photoLookup=registrationNumber?`data-student-photo-number="${esc(registrationNumber)}"`:'';
  if(photo.startsWith('data:image/')) return studentAvatarFrame(`<div class="fiche-photo has-image ${genderClass}" ${photoLookup}><img src="${esc(photo)}" alt="Photo de profil"></div>`,student,clickable);
  const gender=String(student?.sexe||'').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const placeholder=gender==='fille'
    ? '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M12 61c1-14 8-21 20-21s19 7 20 21H12Z" fill="currentColor"/><path d="M16 28C12 12 20 4 32 4s20 8 16 24l-2 18-8-9H26l-8 9-2-18Z" fill="currentColor"/><circle cx="32" cy="24" r="10" fill="var(--surface)"/></svg>'
    : '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M12 61c1-14 8-21 20-21s19 7 20 21H12Z" fill="currentColor"/><path d="M20 23C20 11 25 5 32 5s12 6 12 18l-3-4c-5 2-13 2-18 0l-3 4Z" fill="currentColor"/><circle cx="32" cy="25" r="10" fill="var(--surface)"/><path d="M27 35h10v9H27z" fill="var(--surface)"/></svg>';
  return studentAvatarFrame(`<div class="fiche-photo ${genderClass}" aria-label="Avatar par défaut" ${photoLookup}>${placeholder}</div>`,student,clickable);
}
function studentAvatarFrame(avatar,student,clickable){
  return clickable?`<button type="button" class="student-avatar-trigger" data-student-photo-open aria-label="Agrandir la photo de ${esc(`${student?.prenom||''} ${student?.nom||''}`.trim())}">${avatar}</button>`:avatar;
}
async function hydrateStudentFolderAvatars(root=document){
  const photos=window.hebergia?.photos;
  if(!photos||!root?.querySelectorAll) return;
  const selector='[data-student-photo-number]';
  const avatars=[...(root.matches?.(selector)?[root]:[]),...root.querySelectorAll(selector)];
  await Promise.all(avatars.map(async avatar=>{
    if(avatar.dataset.studentPhotoLoading) return;
    avatar.dataset.studentPhotoLoading='1';
    const image=await photos.readStudentAvatar(avatar.dataset.studentPhotoNumber);
    if(!image||!avatar.isConnected) return;
    avatar.classList.add('has-image');
    avatar.setAttribute('aria-label','Photo du résident');
    avatar.innerHTML=`<img src="${image}" alt="Photo de profil">`;
  }));
}
async function studentAvatarData(file){
  if(!file.type.startsWith('image/')) throw AppError('Veuillez sélectionner un fichier image.');
  if(file.size>10*1024*1024) throw AppError('La photo doit faire moins de 10 Mo.');
  const bitmap=await createImageBitmap(file);
  const scale=Math.min(1,512/Math.max(bitmap.width,bitmap.height));
  const canvas=document.createElement('canvas');
  canvas.width=Math.max(1,Math.round(bitmap.width*scale));
  canvas.height=Math.max(1,Math.round(bitmap.height*scale));
  canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
  bitmap.close();
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',0.84));
  if(!blob) throw AppError('Impossible de lire cette image.');
  return await new Promise((resolve,reject)=>{ const reader=new FileReader(); reader.onload=()=>resolve(reader.result); reader.onerror=()=>reject(AppError('Impossible de lire cette image.')); reader.readAsDataURL(blob); });
}
function bindAvatarUpload(root){
  const input=root.querySelector('[data-avatar-file]');
  const preview=root.querySelector('[data-avatar-preview]');
  if(!input||!preview) throw AppError('Impossible d’initialiser le champ avatar.');
  input.addEventListener('change',async()=>{
    const file=input.files?.[0];
    if(!file) return;
    await safe(async()=>{
      const image=await studentAvatarData(file);
      if(!preview.isConnected) return;
      root.dataset.avatarData=image;
      preview.classList.add('has-image');
      preview.innerHTML=`<img src="${esc(image)}" alt="Avatar">`;
    });
    input.value='';
  });
}
function AppError(msg){ const e = new Error(msg); e.app = true; return e; }
async function safe(fn){ try { await fn(); } catch(err){ toast(err.message || 'Erreur inattendue','error'); } }

const Icons = {
  dash:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
  sidebarCollapse:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>',
  sidebarExpand:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>',
  users:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="8" r="3.4"/><path d="M2.8 20c.7-3.4 3.2-5 6.2-5s5.5 1.6 6.2 5"/><circle cx="17" cy="9" r="2.6"/><path d="M16 15.2c2.6.3 4.5 1.7 5.2 4.3"/></svg>',
  bed:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 19V6"/><path d="M3 13h18v6"/><path d="M3 10h7v3"/><circle cx="7" cy="8.5" r="1.6"/><path d="M10 13V9.5c0-1 .8-1.5 1.8-1.5H19c1.5 0 2 1 2 2.5V13"/></svg>',
  tool:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14.5 6.5a4 4 0 0 0-5.2 5.2L3.6 17.4a2 2 0 1 0 2.8 2.8l5.7-5.7a4 4 0 0 0 5.2-5.2L14.6 12l-2.6-2.6 2.5-2.9z"/></svg>',
  clock:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  key:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="8" cy="15" r="4"/><path d="M11 12 20 3m-4 1 3 3m-6 0 2 2"/></svg>',
  logout:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 4H5.5A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20H9"/><path d="M15 8l4 4-4 4m4-4H9"/></svg>',
  plus:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  search:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.3-4.3"/></svg>',
  eye:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  edit:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17z"/><path d="m13.5 6.5 3 3"/></svg>',
  trash:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13"/></svg>',
  swap:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 8h13l-3-3m3 3-3 3M20 16H7l3-3m-3 3 3 3"/></svg>',
  out:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v9"/><path d="m8.5 8.5 3.5 4 3.5-4"/><rect x="4" y="16" width="16" height="4" rx="1"/></svg>',
  download:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 4v10m0 0 4-4m-4 4-4-4"/><path d="M4 19h16"/></svg>',
  chevronDown:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
  x:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  check:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  alert:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 4 2.8 20h18.4L12 4z"/><path d="M12 10v4m0 3v.5"/></svg>',
  info:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5m0-8v.5"/></svg>',
  power:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v8"/><path d="M6.3 6.5a8 8 0 1 0 11.4 0"/></svg>',
  settings:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.8 13.5 3l1.4 2.4a7.2 7.2 0 0 1 1.8 1l2.7-.7 1.1 1.9-1.9 2a7.4 7.4 0 0 1 .2 2.1l2 1.9-1.1 1.9-2.7-.7a7.2 7.2 0 0 1-1.8 1L13.5 21h-3l-1.4-2.4a7.2 7.2 0 0 1-1.8-1l-2.7.7-1.1-1.9 1.9-2a7.4 7.4 0 0 1-.2-2.1l-2-1.9 1.1-1.9 2.7.7a7.2 7.2 0 0 1 1.8-1L10.5 3h3z"/><circle cx="12" cy="12" r="2.8"/></svg>',
  document:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>',
  sun:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4m0-14.2-1.4 1.4M6.3 17.7l-1.4 1.4"/></svg>',
  moon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 15.3A8.5 8.5 0 0 1 8.7 4 8.5 8.5 0 1 0 20 15.3z"/></svg>'
};

/* ══════════════ SECTION 2 — DATA STORE ══════════════
   Prefer the Electron IPC bridge, with localStorage as a browser fallback. */
const Store = (() => {
  /* La base est désormais dans le processus principal Electron, derrière preload.js. */
  const native = () => window.hebergia?.db;
  const fallbackKey = 'hebergia_db_v1';
  const read = () => { try { return JSON.parse(localStorage.getItem(fallbackKey) || 'null') || {}; } catch { return {}; } };
  const write = value => localStorage.setItem(fallbackKey, JSON.stringify(value));
  async function init(seedFn){
    if (native()){
      await native().init(seedFn());
      const period=await native().get('academicPeriods','active');
      const campaigns=await native().list('renewalCampaigns');
      const selected=campaigns.find(campaign=>campaign.status==='ouverte')||campaigns.find(campaign=>campaign.academicYear===period?.academicYear);
      activeAcademicPeriod.year=selected?.academicYear||period?.academicYear||null;
      activeAcademicPeriod.campaignId=selected?.id||null;
      activeAcademicPeriod.campaignStatus=selected?.status||(period?.renewalsOpen?'ouverte':'brouillon');
      activeAcademicPeriod.renewalsOpen=activeAcademicPeriod.campaignStatus==='ouverte';
      return true;
    }
    const db=read();
    if (!localStorage.getItem(fallbackKey)) Object.assign(db,seedFn());
    db.academicRecords??=[];
    db.housingDossiers??=[];
    db.academicPeriods??=[];
    db.renewalCampaigns??=[];
    db.renewalEvents??=[];
    let period=db.academicPeriods.find(item=>item.id==='active');
    if(!period||academicYearStart(period.academicYear)===null){
      period={id:'active',academicYear:calendarAcademicYear(),renewalsOpen:false,updatedAt:nowISO()};
      if(db.academicPeriods.some(item=>item.id==='active')) Object.assign(db.academicPeriods.find(item=>item.id==='active'),period);
      else db.academicPeriods.push(period);
    }
    activeAcademicPeriod.year=period.academicYear;
    activeAcademicPeriod.renewalsOpen=Boolean(period.renewalsOpen);
    const academicYear=currentAcademicYear(),updatedAt=nowISO();
    let campaign=db.renewalCampaigns.find(item=>item.academicYear===academicYear);
    if(!campaign){
      campaign={id:`renewal-${academicYear}`,academicYear,startDate:null,endDate:null,status:period.renewalsOpen?'ouverte':'brouillon',createdAt:updatedAt,updatedAt,createdBy:''};
      db.renewalCampaigns.push(campaign);
    }
    activeAcademicPeriod.campaignId=campaign.id;
    activeAcademicPeriod.campaignStatus=campaign.status;
    activeAcademicPeriod.renewalsOpen=campaign.status==='ouverte';
    for(const student of db.students||[]){
      if(!db.academicRecords.some(record=>record.studentId===student.id&&record.academicYear===academicYear)){
        db.academicRecords.push({id:`academic-${student.id}-${academicYear}`,studentId:student.id,academicYear,filiere:student.filiere||'',faculte:student.faculte||'',niveau:student.niveau||'',decision:'en_attente',updatedAt});
      }
      if(!db.housingDossiers.some(dossier=>dossier.studentId===student.id&&dossier.academicYear===academicYear)){
        db.housingDossiers.push({id:`housing-${student.id}-${academicYear}`,studentId:student.id,academicYear,status:student.statut==='actif'?'a_renouveler':'clos',notes:'',submittedAt:null,decisionAt:null,updatedAt,campaignId:campaign.id,assignmentStatus:'a_decider',assignmentAction:null,targetRoomId:null,assignedRoomId:null,assignmentReason:'',assignmentConfirmedAt:null,renewalStatus:'en_cours',closedAt:null,closedBy:null});
      }
    }
    write(db);
    return true;
  }
  async function list(coll, options={}){
    if (native()) return native().list(coll,options);
    const rows=read()[coll]||[];
    if(coll==='students'&&options.excludePhotoData) return rows.map(student=>
      typeof student.avatar==='string'&&student.avatar.startsWith('data:image/')?{...student,avatar:''}:student
    );
    return [...rows];
  }
  async function get(coll, id){ if (native()) return native().get(coll,id); return (read()[coll]||[]).find(x=>x.id===id)||null; }
  async function insert(coll, doc){ if (native()) return native().insert(coll,doc); const db=read(); (db[coll]??=[]).push(doc); write(db); return doc; }
  async function update(coll, id, patch){ if (native()) return native().update(coll,id,patch); const db=read(), i=(db[coll]||[]).findIndex(x=>x.id===id); if(i<0) throw AppError('Enregistrement introuvable.'); db[coll][i]={...db[coll][i],...patch,id}; write(db); return db[coll][i]; }
  async function remove(coll, id){ if (native()) return native().remove(coll,id); const db=read(); db[coll]=(db[coll]||[]).filter(x=>x.id!==id); write(db); return true; }
  async function replaceAll(data){
    if (native()){
      await native().replaceAll(data);
      await native().init({});
      const period=await native().get('academicPeriods','active');
      const campaigns=await native().list('renewalCampaigns');
      const selected=campaigns.find(campaign=>campaign.status==='ouverte')||campaigns.find(campaign=>campaign.academicYear===period?.academicYear);
      activeAcademicPeriod.year=selected?.academicYear||period?.academicYear||null;
      activeAcademicPeriod.campaignId=selected?.id||null;
      activeAcademicPeriod.campaignStatus=selected?.status||(period?.renewalsOpen?'ouverte':'brouillon');
      activeAcademicPeriod.renewalsOpen=activeAcademicPeriod.campaignStatus==='ouverte';
      return true;
    }
    write(data||{});
    await init(()=>({}));
    return true;
  }
  return { init, list, get, insert, update, remove, replaceAll, wipe(){ return native() ? native().wipe() : localStorage.removeItem(fallbackKey); } };
})();

/* Lecture groupée (l'équivalent d'une « requête multiple » Realm). */
async function loadSnapshot(){
  const [students, rooms, users, history, complaints, blocks, floors, documentTemplates, documentTypes, academicRecords, housingDossiers, academicPeriods, renewalCampaigns, renewalEvents] = await Promise.all([
    Store.list('students',{excludePhotoData:true}), Store.list('rooms'), Store.list('users'),
    Store.list('history'), Store.list('complaints'), Store.list('blocks'), Store.list('floors'), Store.list('documentTemplates'), Store.list('documentTypes'),
    Store.list('academicRecords'), Store.list('housingDossiers'), Store.list('academicPeriods'), Store.list('renewalCampaigns'), Store.list('renewalEvents')
  ]);
  return { students, rooms, users, history, complaints, blocks, floors, documentTemplates, documentTypes, academicRecords, housingDossiers, academicPeriods, renewalCampaigns, renewalEvents };
}
const snapshotScope=createSnapshotScope(loadSnapshot);
function snapshot(){ return snapshotScope.get(); }
const DOCUMENT_TEMPLATE_TYPES={
  attestation:{label:'Attestation',plural:'Attestations',defaultName:'Attestation Standard'},
  convocation:{label:'Convocation',plural:'Convocations',defaultName:'Convocation Standard'}
};
const DOCUMENT_TEMPLATE_FIELDS={
  attestation:[
    ['nom','Nom','BENALI'],['prenom','Prénom','Ahmed'],['matricule','Matricule','202600123'],
    ['annee_bac','Année du Bac','2026'],['numero_inscription','Numéro d’inscription','2026202600123'],
    ['date_naissance','Date de naissance','12/06/2004'],['lieu_naissance','Lieu de naissance','Alger'],
    ['filiere','Filière','Droit'],['niveau','Niveau d’étude','M1'],['faculte','Faculté / Institut','Faculté de Droit'],
    ['chambre','Chambre','A-107'],['commune','Commune','Bab Ezzouar'],['wilaya','Wilaya','Alger'],
    ['email','E-mail','resident@example.com'],['annee_universitaire','Année universitaire','2026/2027'],
    ['date','Date du document','02/10/2026'],['residence','Résidence universitaire','Résidence universitaire Pepiniere'],
    ['direction','Direction universitaire','Direction des œuvres universitaires'],['service','Service','Service de l’administration']
  ],
  convocation:[
    ['nom','Nom','BENALI'],['prenom','Prénom','Ahmed'],['matricule','Matricule','202600123'],
    ['annee_bac','Année du Bac','2026'],['numero_inscription','Numéro d’inscription','2026202600123'],
    ['date_naissance','Date de naissance','12/06/2004'],['lieu_naissance','Lieu de naissance','Alger'],
    ['filiere','Filière','Droit'],['niveau','Niveau d’étude','M1'],['faculte','Faculté / Institut','Faculté de Droit'],
    ['chambre','Chambre','A-107'],['commune','Commune','Bab Ezzouar'],['wilaya','Wilaya','Alger'],
    ['email','E-mail','resident@example.com'],['annee_universitaire','Année universitaire','2026/2027'],
    ['date','Date du document','02/10/2026'],['residence','Résidence universitaire','Résidence universitaire Pepiniere'],
    ['direction','Direction universitaire','Direction des œuvres universitaires'],['service','Service','Service de l’administration'],
    ['date_convocation','Date du rendez-vous','10/10/2026'],['heure','Heure','10:30'],
    ['lieu','Lieu','Bureau de l’administration'],['objet','Objet','Mise à jour du dossier d’hébergement']
  ]
};
const CUSTOM_DOCUMENT_TEMPLATE_FIELDS=[
  ['nom','Nom','BENALI'],['prenom','Prénom','Ahmed'],['matricule','Matricule','202600123'],
  ['annee_bac','Année du Bac','2026'],['numero_inscription','Numéro d’inscription','2026202600123'],
  ['date_naissance','Date de naissance','12/06/2004'],['lieu_naissance','Lieu de naissance','Alger'],
  ['sexe','Sexe','Femme'],['nationalite','Nationalité','Algérienne'],['filiere','Filière','Droit'],
  ['niveau','Niveau d’étude','M1'],['faculte','Faculté / Institut','Faculté de Droit'],['chambre','Chambre','A-107'],
  ['commune','Commune','Bab Ezzouar'],['wilaya','Wilaya','Alger'],['rue','Adresse','Rue des Frères'],
  ['email','E-mail','resident@example.com'],['telephone','Téléphone','0550123456'],
  ['annee_universitaire','Année universitaire','2026/2027'],['date','Date du document','02/10/2026'],
  ['residence','Résidence universitaire','Résidence universitaire Pepiniere'],
  ['direction','Direction universitaire','Direction des œuvres universitaires'],
  ['service','Service','Service de l’administration'],['date_convocation','Date personnalisée','10/10/2026'],
  ['heure','Heure','10:30'],['lieu','Lieu','Bureau de l’administration'],['objet','Objet','Document administratif']
];
function documentTemplateFields(type){
  return DOCUMENT_TEMPLATE_FIELDS[type]||CUSTOM_DOCUMENT_TEMPLATE_FIELDS;
}
function documentTypeInfo(type,customTypes=[]){
  if(DOCUMENT_TEMPLATE_TYPES[type]) return DOCUMENT_TEMPLATE_TYPES[type];
  const custom=customTypes.find(item=>`custom:${item.id}`===type);
  return custom?{label:custom.name,plural:custom.name,defaultName:`${custom.name} Standard`}:null;
}
function defaultDocumentTemplate(type,typeName='Document administratif'){
  const common={
    orientation:'portrait',margins:{top:20,right:21,bottom:18,left:21},
    logo:'',logoAlignment:'left',headerHtml:'<p>{{direction}}</p><p><strong>{{residence}}</strong></p><p>{{service}}</p>',
    footerHtml:'<p>{{residence}} · {{date}}</p>',signatureTitle:'La direction de la résidence',
    signatureName:'',signatureImage:'',signatureAlignment:'right'
  };
  const attestation={
    title:'Attestation d’hébergement',
    bodyHtml:'<p>Je soussigné(e), responsable de {{residence}}, atteste que :</p><p style="text-align:center"><strong>{{prenom}} {{nom}}</strong></p><p>Matricule {{matricule}}, né(e) le {{date_naissance}} à {{lieu_naissance}}, est actuellement hébergé(e) en chambre {{chambre}} pour l’année universitaire {{annee_universitaire}}.</p><p>La présente attestation est délivrée à l’intéressé(e) pour servir et valoir ce que de droit.</p>'
  };
  const convocation={
    title:'Convocation',
    bodyHtml:'<p>Madame, Monsieur,</p><p>Nous vous prions de bien vouloir vous présenter à {{lieu}} le {{date_convocation}} à {{heure}}.</p><p><strong>Objet :</strong> {{objet}}</p><p>Nous vous remercions de vous munir de votre carte d’étudiant et d’une pièce d’identité.</p>'
  };
  const custom={
    title:typeName,
    customTypeName:typeName,
    bodyHtml:'<p>Document concernant {{prenom}} {{nom}}, résident(e) de {{residence}}.</p><p>Matricule : {{matricule}} · Chambre : {{chambre}}</p>'
  };
  return {...common,...(type==='attestation'?attestation:type==='convocation'?convocation:custom)};
}
function newDocumentTemplate(type,name=documentTypeInfo(type)?.defaultName||'Modèle standard',description='',typeName=''){
  const timestamp=nowISO();
  return {id:uid(),name,type,description,isDefault:true,createdAt:timestamp,updatedAt:timestamp,settings:JSON.stringify(defaultDocumentTemplate(type,typeName))};
}
async function ensureDefaultDocumentTemplate(type,typeName=''){
  const templates=(await Store.list('documentTemplates')).filter(template=>template.type===type);
  if(templates.length){
    const selected=templates.find(template=>template.isDefault)||[...templates].sort((a,b)=>a.createdAt.localeCompare(b.createdAt))[0];
    const invalidDefaults=templates.filter(template=>template.isDefault!==(template.id===selected.id));
    if(invalidDefaults.length) await Promise.all(invalidDefaults.map(template=>Store.update('documentTemplates',template.id,{isDefault:template.id===selected.id,updatedAt:nowISO()})));
    return {...selected,isDefault:true};
  }
  const template=newDocumentTemplate(type,documentTypeInfo(type)?.defaultName||`${typeName} Standard`,'',typeName);
  await Store.insert('documentTemplates',template);
  return template;
}
function parseDocumentTemplate(template){
  try{return JSON.parse(template.settings)}catch(error){throw AppError(`Le modèle « ${template.name} » est invalide : ${error.message}`)}
}
function sanitizeTemplateHtml(html){
  const parsed=new DOMParser().parseFromString(String(html||''),'text/html');
  const allowed=new Set(['P','DIV','BR','STRONG','B','EM','I','U','UL','OL','LI','BLOCKQUOTE','H1','H2','H3','SPAN','FONT']);
  const visit=node=>{
    for(const child of [...node.childNodes]){
      if(child.nodeType===Node.ELEMENT_NODE&&!allowed.has(child.tagName)){
        visit(child);
        child.replaceWith(...child.childNodes);
        continue;
      }
      if(child.nodeType===Node.ELEMENT_NODE){
        const align=child.tagName==='P'||child.tagName==='DIV'?child.style.textAlign:'';
        const fontSize=child.tagName==='FONT'?child.getAttribute('size'):'';
        for(const attribute of [...child.attributes]) child.removeAttribute(attribute.name);
        if(['left','center','right','justify'].includes(align)) child.style.textAlign=align;
        if(child.tagName==='FONT'&&/^[1-7]$/.test(fontSize)) child.setAttribute('size',fontSize);
        visit(child);
      } else if(child.nodeType!==Node.TEXT_NODE) child.remove();
    }
  };
  visit(parsed.body);
  return parsed.body.innerHTML;
}
function documentTemplateValues(type,data={},sample=false){
  const fields=documentTemplateFields(type);
  if(sample){
    const examples=Object.fromEntries(fields.map(([key,,example])=>[key,example]));
    return examples;
  }
  const resident=data.student||{};
  const room=data.room;
  const values={
    nom:resident.nom||'',prenom:resident.prenom||'',matricule:resident.matricule||'',
    annee_bac:resident.anneeBac??'',numero_inscription:resident.numeroInscription||`${resident.anneeBac||''}${resident.matricule||''}`,
    date_naissance:fmtDate(resident.dateNaissance),lieu_naissance:resident.lieuNaissance||'',
    filiere:resident.filiere||'',niveau:resident.niveau||'',faculte:resident.faculte||'',
    sexe:resident.sexe||'',nationalite:resident.nationalite||'',rue:resident.rue||'',telephone:resident.telephone||'',
    chambre:room?roomLabel(room):'',commune:resident.commune||'',wilaya:resident.wilaya||'',email:resident.email||'',annee_universitaire:academicYearFor(nowISO())||'',
    date:fmtDate(nowISO()),residence:localStorage.getItem('hebergia_establishment')?.trim()||'Résidence universitaire Pepiniere',
    direction:localStorage.getItem('hebergia_university_direction')?.trim()||'',
    service:'Service de l’administration',date_convocation:data.dateConvocation||'',
    heure:data.heure||'',lieu:data.lieu||'',objet:data.objet||''
  };
  return Object.fromEntries(fields.map(([key])=>[key,values[key]??'']));
}
function interpolateTemplateHtml(html,values){
  const safeHtml=sanitizeTemplateHtml(html);
  return safeHtml.replace(/\{\{([a-z_]+)\}\}/g,(token,key)=>Object.hasOwn(values,key)?esc(values[key]):esc(token));
}
function templatePageMarkup(template,data={},sample=false){
  const settings=parseDocumentTemplate(template);
  const values=documentTemplateValues(template.type,data,sample);
  const margins=Object.fromEntries(['top','right','bottom','left'].map(side=>[side,Math.max(0,Math.min(40,Number(settings.margins?.[side])||0))]));
  const logo=typeof settings.logo==='string'&&settings.logo.length<=1500000&&/^data:image\/(?:webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(settings.logo)
    ? `<img class="template-logo" src="${settings.logo}" alt="Logo">`:'';
  const signatureImage=typeof settings.signatureImage==='string'&&settings.signatureImage.length<=1500000&&/^data:image\/(?:webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(settings.signatureImage)
    ? `<img class="template-signature-image" src="${settings.signatureImage}" alt="Signature">`:'';
  const logoPosition=['left','center','right'].includes(settings.logoAlignment)?settings.logoAlignment:'left';
  const signaturePosition=['left','center','right'].includes(settings.signatureAlignment)?settings.signatureAlignment:'right';
  const title=esc(String(settings.title||documentTypeInfo(template.type)?.label||settings.customTypeName||'Document')).replace(/\{\{([a-z_]+)\}\}/g,(token,key)=>Object.hasOwn(values,key)?esc(values[key]):esc(token));
  return `<article class="resident-document-sheet template-document" style="--page-width:${settings.orientation==='landscape'?'297mm':'210mm'};--page-height:${settings.orientation==='landscape'?'210mm':'297mm'};--page-padding:${margins.top}mm ${margins.right}mm ${margins.bottom}mm ${margins.left}mm">
    ${sample?'<div class="template-sample-watermark">APERÇU · DONNÉES EXEMPLE</div>':''}
    <header class="template-document-header" style="justify-content:${logoPosition==='center'?'center':logoPosition==='right'?'flex-end':'flex-start'};text-align:${logoPosition}">${logo}<div>${interpolateTemplateHtml(settings.headerHtml,values)}</div></header>
    <h1 class="template-document-title">${title}</h1>
    <main class="template-document-body">${interpolateTemplateHtml(settings.bodyHtml,values)}</main>
    ${settings.signatureTitle||settings.signatureName||signatureImage?`<section class="template-document-signature" style="align-items:${signaturePosition==='center'?'center':signaturePosition==='right'?'flex-end':'flex-start'};text-align:${signaturePosition}"><strong>${esc(settings.signatureTitle||'')}</strong>${settings.signatureName?`<span>${esc(settings.signatureName)}</span>`:''}${signatureImage}</section>`:''}
    <footer class="template-document-footer">${interpolateTemplateHtml(settings.footerHtml,values)}</footer>
  </article>`;
}
function templatePreviewDocument(template,sample=true,data={}){
  const settings=parseDocumentTemplate(template);
  const landscape=settings.orientation==='landscape';
  return `<!doctype html><html lang="fr"><meta charset="utf-8"><style>
    *{box-sizing:border-box}html,body{margin:0;min-height:100%;background:#eef1f3;color:#1b2935;font:12pt Georgia,'Times New Roman',serif;line-height:1.6}body{zoom:${landscape?'.44':'.62'}}
    .template-document{box-sizing:border-box;width:${landscape?'297mm':'210mm'};min-height:${landscape?'210mm':'297mm'};margin:12px auto;padding:${Math.max(0,Math.min(40,Number(settings.margins?.top)||0))}mm ${Math.max(0,Math.min(40,Number(settings.margins?.right)||0))}mm ${Math.max(0,Math.min(40,Number(settings.margins?.bottom)||0))}mm ${Math.max(0,Math.min(40,Number(settings.margins?.left)||0))}mm;background:#fff;display:flex;flex-direction:column;position:relative}
    .template-document-header{display:flex;align-items:center;gap:12px;padding-bottom:12px;border-bottom:1px solid #aab6c2;font:10pt Arial,sans-serif;color:#536474}
    .template-document-header p{margin:2px 0}.template-logo{max-width:32mm;max-height:22mm;object-fit:contain}
    .template-document-title{margin:18mm 0 10mm;text-align:center;font:bold 19pt Arial,sans-serif;color:#142b40;text-transform:uppercase}
    .template-document-body{flex:1}.template-document-body p{margin:0 0 6mm}
    .template-document-signature{display:flex;flex-direction:column;gap:5px;margin-top:auto;padding-top:14mm;break-inside:avoid;font:11pt Arial,sans-serif}
    .template-document-signature span{margin-top:2mm}.template-signature-image{max-width:48mm;max-height:24mm;object-fit:contain}
    .template-document-footer{margin-top:10mm;padding-top:4mm;border-top:1px solid #d7dee5;text-align:center;color:#687684;font:8pt Arial,sans-serif}
    .template-sample-watermark{position:absolute;top:5mm;right:6mm;padding:4px 7px;background:#fff3cd;color:#795b16;font:700 8pt Arial,sans-serif}
  </style><body>${templatePageMarkup(template,data,sample)}</body></html>`;
}
async function setDefaultDocumentTemplate(id,type){
  const templates=(await Store.list('documentTemplates')).filter(template=>template.type===type);
  if(!templates.some(template=>template.id===id)) throw AppError('Modèle introuvable.');
  await Promise.all(templates.map(template=>Store.update('documentTemplates',template.id,{isDefault:template.id===id,updatedAt:nowISO()})));
}
async function renderDocumentTemplates(root){
  const host=root.querySelector('[data-document-templates-list]');
  if(!host) return;
  for(const type of Object.keys(DOCUMENT_TEMPLATE_TYPES)) await ensureDefaultDocumentTemplate(type);
  const customTypes=await Store.list('documentTypes');
  for(const customType of customTypes) await ensureDefaultDocumentTemplate(`custom:${customType.id}`,customType.name);
  const templates=await Store.list('documentTemplates');
  const groups=[
    ...Object.entries(DOCUMENT_TEMPLATE_TYPES).map(([type,meta])=>({type,meta})),
    ...customTypes.map(item=>({type:`custom:${item.id}`,meta:documentTypeInfo(`custom:${item.id}`,customTypes)}))
  ];
  host.innerHTML=`<div class="document-template-management"><button class="btn btn-primary" data-template-action="new-custom-type">${Icons.plus} Nouveau modèle de document</button><div class="document-template-groups">${groups.map(({type,meta})=>{
    const rows=templates.filter(template=>template.type===type).sort((a,b)=>a.name.localeCompare(b.name,'fr'));
    const selected=rows.find(template=>template.isDefault)||rows[0];
    return `<section class="document-template-group" data-template-type="${type}">
      <div class="document-template-group-head"><h5>${meta.plural}</h5><span class="spacer"></span>
      <label style="font-size:11px;color:var(--muted)">Modèle par défaut <select class="inp" data-template-default="${type}" style="display:inline-block;width:auto;min-width:180px;margin-left:5px">${rows.map(template=>`<option value="${esc(template.id)}" ${template.id===selected?.id?'selected':''}>${esc(template.name)}</option>`).join('')}</select></label>
      <button class="btn btn-primary btn-sm" data-template-action="new" data-template-type="${type}">${Icons.plus} Nouveau modèle ${type==='attestation'?'d’attestation':type==='convocation'?'de convocation':`de ${esc(meta.label)}`}</button></div>
      ${rows.map(template=>`<article class="document-template-card"><div class="document-template-card-copy"><strong>${template.isDefault?'★ ':''}${esc(template.name)}${template.isDefault?'<span class="badge b-ok">Par défaut</span>':''}</strong><p>${esc(template.description||meta.label)} · Modifié le ${esc(fmtDate(template.updatedAt))}</p></div><div class="document-template-actions"><button class="btn btn-ghost btn-sm" data-template-action="edit" data-template-id="${esc(template.id)}">Modifier</button><button class="btn btn-ghost btn-sm" data-template-action="duplicate" data-template-id="${esc(template.id)}">Dupliquer</button><button class="btn btn-ghost btn-sm" data-template-action="preview" data-template-id="${esc(template.id)}">Aperçu</button><button class="btn btn-danger btn-sm" data-template-action="delete" data-template-id="${esc(template.id)}">Supprimer</button></div></article>`).join('')}
    </section>`;
  }).join('')}</div></div>`;
  host.querySelectorAll('[data-template-default]').forEach(select=>select.addEventListener('change',()=>safe(async()=>{
    await setDefaultDocumentTemplate(select.value,select.dataset.templateDefault);
    await renderDocumentTemplates(root);
    toast('Modèle par défaut mis à jour.','success');
  })));
  host.querySelectorAll('[data-template-action]').forEach(button=>button.addEventListener('click',()=>safe(async()=>{
    const action=button.dataset.templateAction;
    if(action==='new'){
      const type=button.dataset.templateType;
      const customType=customTypes.find(item=>`custom:${item.id}`===type);
      return openDocumentTemplateEditor(type,null,customType?.name||'');
    }
    if(action==='new-custom-type') return openCustomDocumentTypeDialog();
    const template=await Store.get('documentTemplates',button.dataset.templateId);
    if(!template) throw AppError('Modèle introuvable.');
    if(action==='edit') return openDocumentTemplateEditor(template.type,template);
    if(action==='preview') return previewDocumentTemplate(template);
    if(action==='duplicate'){
      const all=(await Store.list('documentTemplates')).filter(row=>row.type===template.type);
      let name=`${template.name} - Copie`,suffix=2;
      while(all.some(row=>row.name.trim().toLocaleLowerCase('fr')===name.toLocaleLowerCase('fr'))) name=`${template.name} - Copie ${suffix++}`;
      await Store.insert('documentTemplates',{...template,id:uid(),name,isDefault:false,createdAt:nowISO(),updatedAt:nowISO()});
      await renderDocumentTemplates(root);
      toast('Modèle dupliqué.','success');
      return;
    }
    if(action==='delete'){
      if(!(await confirmDialog({title:'Supprimer le modèle ?',danger:true,ok:'Supprimer',message:`Voulez-vous vraiment supprimer « ${template.name} » ? Cette action est irréversible.`}))) return;
      await Store.remove('documentTemplates',template.id);
      if(template.type.startsWith('custom:')&&!(await Store.list('documentTemplates')).some(row=>row.type===template.type)){
        await Store.remove('documentTypes',template.type.slice('custom:'.length));
      }else if(template.isDefault) await ensureDefaultDocumentTemplate(template.type);
      await renderDocumentTemplates(root);
      toast('Modèle supprimé.','success');
    }
  })));
}
function openCustomDocumentTypeDialog(){
  Modal.open({title:'Nouveau modèle de document',sub:'Ajoutez un nouveau type de document et son premier modèle.',
    body:'<div class="field"><label>Nom du type de document</label><input class="inp" name="documentTypeName" maxlength="60" placeholder="Ex. Certificat de résidence" required></div>',
    footer:'<button class="btn btn-ghost" data-mclose>Annuler</button><button class="btn btn-primary" data-create-document-type>Continuer</button>',
    onMount:overlay=>overlay.querySelector('[data-create-document-type]').addEventListener('click',event=>{
      event.preventDefault();
      safe(async()=>{
        const name=overlay.querySelector('[name="documentTypeName"]').value.trim();
        if(!name) throw AppError('Le nom du type de document est obligatoire.');
        const existingTypes=await Store.list('documentTypes');
        if([...Object.values(DOCUMENT_TEMPLATE_TYPES).map(info=>info.label),...existingTypes.map(item=>item.name)].some(value=>value.trim().toLocaleLowerCase('fr')===name.toLocaleLowerCase('fr')))throw AppError('Ce type de document existe déjà.');
        const typeRecord={id:uid(),name,createdAt:nowISO()};
        await Store.insert('documentTypes',typeRecord);
        const type=`custom:${typeRecord.id}`;
        const template=newDocumentTemplate(type,`${name} Standard`,'',name);
        await Store.insert('documentTemplates',template);
        Modal.close();
        openDocumentTemplateEditor(type,template,name);
      });
    })});
}
function previewDocumentTemplate(template,data={},sample=true){
  const page=templatePreviewDocument(template,sample,data);
  Modal.open({title:`Aperçu — ${template.name}`,wide:true,body:`<iframe class="document-template-preview-frame" title="Aperçu du modèle" sandbox></iframe>`,footer:'<button class="btn btn-ghost" data-mclose>Fermer</button>',onMount:overlay=>{overlay.querySelector('iframe').srcdoc=page;}});
}
function openDocumentTemplateEditor(type,existing=null,typeName=''){
  const customName=typeName||((existing&&parseDocumentTemplate(existing).customTypeName)||'');
  const types=[...Object.keys(DOCUMENT_TEMPLATE_TYPES),...(type.startsWith('custom:')?[type]:[])];
  const settings=existing?parseDocumentTemplate(existing):defaultDocumentTemplate(type,customName);
  const initialName=existing?.name||DOCUMENT_TEMPLATE_TYPES[type]?.defaultName||`${customName} Standard`;
  const initialDescription=existing?.description||'';
  const fileData={logo:settings.logo||'',signatureImage:settings.signatureImage||''};
  const editorMarkup=(key,label,html)=>`<div class="field"><label>${label}</label><div class="document-template-toolbar"><button class="btn btn-ghost btn-sm" type="button" data-format="bold"><b>G</b></button><button class="btn btn-ghost btn-sm" type="button" data-format="italic"><i>I</i></button><button class="btn btn-ghost btn-sm" type="button" data-format="underline"><u>S</u></button><button class="btn btn-ghost btn-sm" type="button" data-format="justifyLeft">Gauche</button><button class="btn btn-ghost btn-sm" type="button" data-format="justifyCenter">Centrer</button><button class="btn btn-ghost btn-sm" type="button" data-format="justifyRight">Droite</button><select class="inp" data-font-size style="width:auto;padding:4px"><option value="2">Petit</option><option value="3" selected>Normal</option><option value="4">Grand</option><option value="5">Très grand</option></select></div><div class="document-template-editable" contenteditable="true" data-template-editable="${key}">${sanitizeTemplateHtml(html)}</div></div>`;
  const fieldsHtml=documentTemplateFields(type).map(([key,label])=>`<button class="btn btn-ghost btn-sm" type="button" data-template-insert="${key}" title="Insérer {{${key}}}">${esc(label)}</button>`).join('');
  const margins=settings.margins||{};
  Modal.open({title:existing?'Modifier le modèle':'Nouveau modèle',sub:'Personnalisez la mise en page et le texte du document.',wide:true,className:'template-editor-modal',
    body:`<div class="document-template-editor"><div class="document-template-editor-form">
      <div class="fgrid"><div class="field"><label>Nom du modèle</label><input class="inp" name="templateName" required maxlength="80" value="${esc(initialName)}"></div>
      <div class="field"><label>Type de document</label><select class="inp" name="templateType" ${existing?'disabled':''}>${types.map(value=>`<option value="${esc(value)}" ${value===type?'selected':''}>${esc(DOCUMENT_TEMPLATE_TYPES[value]?.label||customName)}</option>`).join('')}</select></div>
      <div class="field full"><label>Description (facultatif)</label><input class="inp" name="templateDescription" maxlength="200" value="${esc(initialDescription)}"></div></div>
      <div class="font-fields"><div class="field"><label>Format de page</label><input class="inp" value="A4" disabled></div><div class="field"><label>Orientation</label><select class="inp" name="orientation"><option value="portrait" ${settings.orientation!=='landscape'?'selected':''}>Portrait</option><option value="landscape" ${settings.orientation==='landscape'?'selected':''}>Paysage</option></select></div></div>
      <div class="field"><label>Marges (mm)</label><div class="triple">${['top','right','bottom','left'].map((side,index)=>`<div><label>${['Haut','Droite','Bas','Gauche'][index]}</label><input class="inp" type="number" name="margin-${side}" min="0" max="40" value="${Number(margins[side]??[20,21,18,21][index])}"></div>`).join('')}</div></div>
      <div class="font-fields"><div class="field"><label>Logo de l’établissement</label><div class="template-file-picker"><input type="file" accept="image/png,image/jpeg,image/webp" data-template-image="logo" aria-label="Choisir un logo"><button class="btn btn-ghost btn-sm" type="button" data-template-image-trigger="logo">Choisir un fichier</button><span class="template-file-name" data-template-image-name="logo">${fileData.logo?'Image déjà enregistrée':'Aucun fichier choisi'}</span></div><button class="template-image-remove" type="button" data-template-image-remove="logo">Retirer le logo</button></div><div class="field"><label>Position du logo</label><select class="inp" name="logoAlignment"><option value="left">À gauche</option><option value="center">Au centre</option><option value="right">À droite</option></select></div></div>
      ${editorMarkup('header','En-tête',settings.headerHtml)}
      <div class="field"><label>Titre du document</label><input class="inp" name="templateTitle" maxlength="120" value="${esc(settings.title||'')}"></div>
      ${editorMarkup('body','Contenu',settings.bodyHtml)}
      ${editorMarkup('footer','Pied de page',settings.footerHtml)}
      <div class="field"><label>Champs dynamiques disponibles</label><p style="font-size:11px;color:var(--muted)">Cliquez dans l’en-tête, le contenu ou le pied de page, puis choisissez un champ.</p><div class="document-template-fields">${fieldsHtml}</div></div>
      <div class="font-fields"><div class="field"><label>Titre de signature</label><input class="inp" name="signatureTitle" maxlength="100" value="${esc(settings.signatureTitle||'')}"></div><div class="field"><label>Nom du signataire (facultatif)</label><input class="inp" name="signatureName" maxlength="100" value="${esc(settings.signatureName||'')}"></div></div>
      <div class="font-fields"><div class="field"><label>Alignement de signature</label><select class="inp" name="signatureAlignment"><option value="left">À gauche</option><option value="center">Au centre</option><option value="right">À droite</option></select></div><div class="field"><label>Image de signature (facultatif)</label><div class="template-file-picker"><input type="file" accept="image/png,image/jpeg,image/webp" data-template-image="signatureImage" aria-label="Choisir une image de signature"><button class="btn btn-ghost btn-sm" type="button" data-template-image-trigger="signatureImage">Choisir un fichier</button><span class="template-file-name" data-template-image-name="signatureImage">${fileData.signatureImage?'Image déjà enregistrée':'Aucun fichier choisi'}</span></div><button class="template-image-remove" type="button" data-template-image-remove="signatureImage">Retirer la signature</button></div></div>
    </div><aside class="document-template-editor-preview"><b>Aperçu en direct</b><iframe class="document-template-preview-frame" title="Aperçu du modèle avec données exemple" sandbox></iframe></aside></div>`,
    footer:`<button class="btn btn-ghost" data-mclose>Annuler</button><button class="btn btn-primary" data-template-save>Enregistrer le modèle</button>`,
    onMount:overlay=>{
      const form=overlay.querySelector('.m-form'), iframe=overlay.querySelector('iframe');
      form.elements.logoAlignment.value=settings.logoAlignment||'left';
      form.elements.signatureAlignment.value=settings.signatureAlignment||'right';
      let lastEditable=overlay.querySelector('[data-template-editable="body"]');
      const collect=()=>{
        const typeValue=form.elements.templateType.value;
        const next={...settings,orientation:form.elements.orientation.value,
          margins:Object.fromEntries(['top','right','bottom','left'].map(side=>[side,Math.max(0,Math.min(40,Number(form.elements[`margin-${side}`].value)||0))])),
          logo:fileData.logo,logoAlignment:form.elements.logoAlignment.value,
          headerHtml:sanitizeTemplateHtml(overlay.querySelector('[data-template-editable="header"]').innerHTML),
          title:form.elements.templateTitle.value,bodyHtml:sanitizeTemplateHtml(overlay.querySelector('[data-template-editable="body"]').innerHTML),
          footerHtml:sanitizeTemplateHtml(overlay.querySelector('[data-template-editable="footer"]').innerHTML),
          signatureTitle:form.elements.signatureTitle.value,signatureName:form.elements.signatureName.value,
          signatureImage:fileData.signatureImage,signatureAlignment:form.elements.signatureAlignment.value};
        return {type:typeValue,settings:next};
      };
      const refreshPreview=()=>{const current=collect();iframe.srcdoc=templatePreviewDocument({type:current.type,name:form.elements.templateName.value,settings:JSON.stringify(current.settings)},true);};
      overlay.querySelectorAll('[data-template-editable]').forEach(editable=>{
        editable.addEventListener('focus',()=>{lastEditable=editable;});
        editable.addEventListener('input',refreshPreview);
      });
      form.addEventListener('input',event=>{if(!event.target.matches('[contenteditable]'))refreshPreview();});
      form.addEventListener('change',refreshPreview);
      overlay.querySelectorAll('[data-format]').forEach(button=>button.addEventListener('mousedown',event=>event.preventDefault()));
      overlay.querySelectorAll('[data-format]').forEach(button=>button.addEventListener('click',()=>{
        lastEditable.focus();document.execCommand(button.dataset.format,false,null);refreshPreview();
      }));
      overlay.querySelector('[data-font-size]').addEventListener('change',event=>{
        lastEditable.focus();document.execCommand('fontSize',false,event.target.value);refreshPreview();
      });
      overlay.querySelectorAll('[data-template-insert]').forEach(button=>button.addEventListener('click',()=>{
        lastEditable.focus();document.execCommand('insertText',false,`{{${button.dataset.templateInsert}}}`);refreshPreview();
      }));
      overlay.querySelectorAll('[data-template-image]').forEach(input=>input.addEventListener('change',async()=>{
        const file=input.files?.[0];if(!file)return;
        await safe(async()=>{
          fileData[input.dataset.templateImage]=await studentAvatarData(file);
          overlay.querySelector(`[data-template-image-name="${input.dataset.templateImage}"]`).textContent=file.name;
          refreshPreview();
        });
      }));
      overlay.querySelectorAll('[data-template-image-trigger]').forEach(button=>button.addEventListener('click',()=>{
        overlay.querySelector(`[data-template-image="${button.dataset.templateImageTrigger}"]`).click();
      }));
      overlay.querySelectorAll('[data-template-image-remove]').forEach(button=>button.addEventListener('click',()=>{
        fileData[button.dataset.templateImageRemove]='';
        const input=overlay.querySelector(`[data-template-image="${button.dataset.templateImageRemove}"]`);if(input)input.value='';
        overlay.querySelector(`[data-template-image-name="${button.dataset.templateImageRemove}"]`).textContent='Aucun fichier choisi';
        refreshPreview();
      }));
      overlay.querySelector('[data-template-save]').addEventListener('click',event=>{
        event.preventDefault();
        safe(async()=>{
          const typeValue=form.elements.templateType.value;
          const name=form.elements.templateName.value.trim();
          if(!name)throw AppError('Le nom du modèle est obligatoire.');
          const existingTemplates=(await Store.list('documentTemplates')).filter(template=>template.type===typeValue);
          if(existingTemplates.some(template=>template.id!==existing?.id&&template.name.trim().toLocaleLowerCase('fr')===name.toLocaleLowerCase('fr')))throw AppError('Un modèle de ce type porte déjà ce nom.');
          const current=collect();
          const record={id:existing?.id||uid(),name,type:typeValue,description:form.elements.templateDescription.value.trim(),isDefault:existing?.type===typeValue?existing.isDefault:!existingTemplates.length,createdAt:existing?.createdAt||nowISO(),updatedAt:nowISO(),settings:JSON.stringify({...current.settings,...(typeValue.startsWith('custom:')?{customTypeName:customName}:{})})};
          if(existing)await Store.update('documentTemplates',existing.id,record);else await Store.insert('documentTemplates',record);
          if(record.isDefault)await setDefaultDocumentTemplate(record.id,typeValue);
          Modal.close();await renderDocumentTemplates(document.querySelector('#settings-page-root'));
          toast(existing?'Modèle mis à jour.':'Modèle enregistré.','success');
        });
      });
      refreshPreview();
    }});
}

/* ══════════════ SECTION 3 — SERVICE MÉTIER (règles de gestion) ══════════════ */
const Services = {
  /* — Affectation / transfert d'un étudiant dans une chambre — */
  async assign(studentId, roomId, motif){
    const snap = await snapshot();
    const student = snap.students.find(s => s.id === studentId);
    const room = snap.rooms.find(r => r.id === roomId);
    if (!student || !room) throw AppError('Étudiant ou chambre introuvable.');
    assertBlockGenderCompatible(snap,student,room);
    if (room.statut === 'hors_service') throw AppError(`La chambre ${roomLabel(room)} est hors service.`);
    const occ = snap.students.filter(s => s.chambreId === room.id && s.statut === 'actif' && s.id !== student.id).length;
    if (occ >= room.capacite) throw AppError(`Capacité atteinte : ${roomLabel(room)} est complète (${occ}/${room.capacite}).`);
    const from = student.chambreId ? snap.rooms.find(r => r.id === student.chambreId) : null;
    if (from && from.id === room.id) throw AppError('L\u2019étudiant est déjà dans cette chambre.');
    const type = from ? 'transfert' : 'entree';
    await Store.update('students', student.id, { chambreId: room.id, statut:'actif' });
    await Store.insert('history', {
      id: uid(), date: nowISO(), type, studentId: student.id,
      studentName: `${student.nom} ${student.prenom}`,
      roomId: room.id, roomLabel: roomLabel(room), bloc: room.bloc,
      fromRoomLabel: from ? roomLabel(from) : null,
      motif: motif || (type === 'transfert' ? 'Transfert' : 'Affectation initiale'),
      userName: Session.user.name
    });
    return { type };
  },

  /* — Libération / sortie d'un étudiant — */
  async release(studentId, motif){
    const snap = await snapshot();
    const student = snap.students.find(s => s.id === studentId);
    if (!student || !student.chambreId) throw AppError('Cet étudiant n\u2019occupe aucune chambre.');
    const room = snap.rooms.find(r => r.id === student.chambreId);
    await Store.update('students', student.id, { chambreId: null, statut: 'sorti' });
    await Store.insert('history', {
      id: uid(), date: nowISO(), type: 'sortie', studentId: student.id,
      studentName: `${student.nom} ${student.prenom}`,
      roomId: room ? room.id : null, roomLabel: room ? roomLabel(room) : '?',
      bloc: room ? room.bloc : '', fromRoomLabel: null,
      motif: motif || 'Départ de la résidence', userName: Session.user.name
    });
  },

  /* — Suppression d'un étudiant (admin uniquement, cf. Section 4) — */
  async deleteStudent(studentId){
    const s = await Store.get('students', studentId);
    if (!s) throw AppError('Étudiant introuvable.');
    if (s.chambreId) throw AppError('Libérez d\u2019abord la chambre occupée avant de supprimer la fiche.');
    await Store.remove('students', studentId);
  }
};

/* ══════════════ SECTION 4 — SESSION & PERMISSIONS ══════════════ */
const Session = {
  user: null,
  bloc(){ return this.user ? this.user.bloc : null; }
};
const isAdmin = () => !!Session.user && Session.user.role==='admin';
function requireAdmin(){ if (!Session.user || Session.user.role!=='admin') throw AppError('Cette action est réservée à l’administrateur.'); }
function requireBloc(_bloc){ if (!Session.user) throw AppError('Session utilisateur absente.'); }
function renewalBridge(){
  if(!Session.user) throw AppError('Connectez-vous pour gérer les renouvellements.');
  const bridge=window.hebergia?.renewals;
  if(!bridge) throw AppError('Les opérations de renouvellement nécessitent l’application Electron.');
  return {
    ensureDossier:(studentId,campaignId)=>bridge.ensureDossier(studentId,campaignId,Session.user.id),
    createCampaign:campaign=>bridge.createCampaign(campaign,Session.user.id),
    updateCampaignDates:(campaignId,startDate,endDate)=>bridge.updateCampaignDates(campaignId,startDate,endDate,Session.user.id),
    setCampaignStatus:(campaignId,status)=>bridge.setCampaignStatus(campaignId,status,Session.user.id),
    updateDossier:(dossierId,status,notes,academicData=null)=>bridge.updateDossier(dossierId,status,notes,academicData,Session.user.id),
    setAssignment:(dossierId,roomId,reason)=>bridge.setAssignment(dossierId,roomId,reason,Session.user.id),
    confirmAssignment:dossierId=>bridge.confirmAssignment(dossierId,Session.user.id),
    recordKeyOperation:(dossierId,operation,reason)=>bridge.recordKeyOperation(dossierId,operation,reason,Session.user.id),
    closeDossier:dossierId=>bridge.closeDossier(dossierId,Session.user.id)
  };
}
async function loadRenewalSnapshot(){
  const bridge=window.hebergia?.renewals;
  return bridge?.getSnapshot&&Session.user?bridge.getSnapshot(Session.user.id):snapshot();
}

/* Filtrage par rôle : un agent ne voit que son bloc. */
const Scope = {
  rooms(snap){ return snap.rooms; },
  students(snap){
    return snap.students;
  },
  complaints(snap){ return snap.complaints; },
  history(snap){ return isAdmin() ? snap.history : []; }
};

/* ══════════════ SECTION 5 — INITIAL DATA ══════════════ */
function buildSeed(){
  return { students:[], rooms:[], users:[], history:[], complaints:[], blocks:[], floors:[] };
}

/* ══════════════ SECTION 6 — UI KIT : toasts, modales, confirmations, CSV ══════════════ */
const uiTranslations = new Map([
  ['Settings', 'Paramètres'], ['Save settings', 'Enregistrer les paramètres'],
  ['General', 'Général'], ['Appearance', 'Apparence'], ['Data and Backups', 'Données et sauvegardes'],
  ['Users manager', 'Gestion des utilisateurs'], ['Basic application preferences.', 'Préférences générales de l’application.'],
  ['Establishment name', 'Nom de l’établissement'],
  ['English (coming soon)', 'Anglais (bientôt disponible)'], ['Start page', 'Page de démarrage'],
  ['Customize the visual identity and reading comfort.', 'Personnalisez l’apparence et le confort de lecture.'],
  ['Adjust how information is displayed.', 'Réglez l’affichage des informations.'],
  ['Theme', 'Thème'], ['Light mode', 'Mode clair'], ['Dark mode', 'Mode sombre'],
  ['Hebergia Blue · Green · Orange', 'Hebergia · bleu · vert · orange'], ['Classic Blue', 'Bleu classique'],
  ['Fresh Green', 'Vert vif'], ['Warm Orange', 'Orange chaleureux'], ['Plum Modern', 'Prune moderne'],
  ['Slate Professional', 'Ardoise professionnelle'], ['Title font', 'Police des titres'],
  ['Text font', 'Police du texte'], ['Text size', 'Taille du texte'], ['Small', 'Petit'], ['Big', 'Grand'],
  ['Compact room and Bloc cards', 'Cartes compactes des chambres et des blocs'],
  ['Use interface animations', 'Utiliser les animations de l’interface'],
  ['Import, export, and protect the data stored on this computer.', 'Importez, exportez et protégez les données enregistrées sur cet ordinateur.'],
  ['Import / Export data', 'Importer / exporter les données'],
  ['Students and complaints only. Supported formats: Excel (.xlsx), CSV, and JSON.', 'Étudiants et réclamations uniquement. Formats acceptés : Excel (.xlsx), CSV et JSON.'],
  ['Import', 'Importer'], ['Export', 'Exporter (Excel)'], ['Backups', 'Sauvegardes'],
  ['Excel (.xls)', 'Excel (.xlsx) · par défaut'],
  ['Create or restore a portable JSON backup before reinstalling or moving the application.', 'Créez ou restaurez une sauvegarde JSON avant de réinstaller ou de déplacer l’application.'],
  ['Backups include residents, user accounts, rooms, renewals, complaints, and history. Accounts not yet signed in since password protection was added may still have plaintext passwords in the backup; keep it secure. Separate photo files are not included; maximum restore file size is 100 MB.', 'Les sauvegardes incluent les résidents, comptes utilisateurs, chambres, renouvellements, réclamations et mouvements. Les comptes qui ne se sont pas encore connectés depuis l’ajout de la protection peuvent encore avoir leur mot de passe en clair dans la sauvegarde ; protégez-la. Les photos enregistrées séparément ne sont pas incluses ; taille maximale de restauration : 100 Mo.'],
  ['Export backup', 'Exporter une sauvegarde'], ['Import backup', 'Importer une sauvegarde'],
  ['Reset the app', 'Réinitialiser l’application'],
  ['Permanently delete all local data and restore the initial setup.', 'Supprimez définitivement toutes les données locales et restaurez la configuration initiale.'],
  ['Reset all data', 'Réinitialiser toutes les données'],
  ['Manage administrators and users who can access this application.', 'Gérez les administrateurs et les utilisateurs autorisés à accéder à cette application.'],
  ['Users', 'Utilisateurs'], ['+ New user', '+ Nouvel utilisateur'], ['Name', 'Nom'],
  ['Username', 'Identifiant'], ['Phone', 'Téléphone'], ['Role', 'Rôle'], ['Status', 'Statut'],
  ['Settings sections', 'Sections des paramètres'], ['Close', 'Fermer'],
  ['Your data is stored locally on this computer.', 'Vos données sont stockées localement sur cet ordinateur.'],
  ['Local database', 'Base de données locale'],
  ['Export a complete JSON backup before moving or reinstalling the application.', 'Exportez une sauvegarde JSON complète avant de déplacer ou de réinstaller l’application.'],
  ['Settings saved.', 'Paramètres enregistrés.'], ['Backup exported.', 'Sauvegarde exportée.'],
  ['Import Excel/CSV will be available with the import assistant.', 'L’import Excel/CSV sera disponible avec l’assistant d’importation.']
]);
function translateRenderedUi(root){
  const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
  let node;
  while((node=walker.nextNode())){
    const original=node.nodeValue, trimmed=original.trim(), translated=uiTranslations.get(trimmed);
    if(translated) node.nodeValue=original.replace(trimmed,translated);
  }
  root.querySelectorAll('[aria-label],[title]').forEach(element=>{
    for(const attribute of ['aria-label','title']){
      const value=element.getAttribute(attribute), translated=uiTranslations.get(value);
      if(translated) element.setAttribute(attribute,translated);
    }
  });
}
function toast(msg, type='info'){
  msg=uiTranslations.get(msg)||msg;
  const ic = { success:Icons.check, error:Icons.alert, warning:Icons.alert, info:Icons.info }[type] || Icons.info;
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = ic + `<span>${esc(msg)}</span>`;
  $('toast-root').appendChild(el);
  setTimeout(()=>el.classList.add('out'), 3600);
  setTimeout(()=>el.remove(), 3950);
}

const Modal = (() => {
  let ov = null, onCloseCb = null;
  function open({ title, sub='', body, footer='', wide=false, className='', overlayClassName='', hideHeader=false, onMount, onClose } ={}){
    close(true);
    onCloseCb = onClose || null;
    ov = document.createElement('div');
    ov.className = `overlay${overlayClassName?' '+overlayClassName:''}`;
    ov.innerHTML =
      `<div class="modal${wide?' wide':''}${className?' '+className:''}" role="dialog" aria-modal="true"${hideHeader?` aria-label="${esc(title)}"`:''}>
        ${hideHeader?'':`<div class="m-head">
          <div><h3>${title}</h3>${sub?`<div class="m-sub">${sub}</div>`:''}</div>
          <button class="btn-icon hov-bad m-close" data-mclose title="Fermer">${Icons.x}</button>
        </div>`}
        <form class="m-form">
          <div class="m-body">${body}</div>
          ${footer?`<div class="m-foot">${footer}</div>`:''}
        </form>
      </div>`;
    $('modal-root').appendChild(ov);
    requestAnimationFrame(()=>ov.classList.add('show'));
    ov.addEventListener('mousedown', e => { if (e.target === ov) close(); });
    ov.querySelectorAll('[data-mclose]').forEach(b => b.addEventListener('click', e => { e.preventDefault(); close(); }));
    ov.querySelector('form').addEventListener('submit', e => e.preventDefault());
    if (onMount) onMount(ov, close);
    const f = ov.querySelector('input:not([type=hidden]),select,textarea');
    if (f) setTimeout(()=>f.focus(), 80);
    return { root: ov, close };
  }
  function close(instant){
    if (!ov) return;
    const o = ov, cb = onCloseCb;
    ov = null; onCloseCb = null;
    o.classList.remove('show');
    if (cb) cb();
    if (instant) { o.remove(); return; }
    setTimeout(()=>o.remove(), 210);
  }
  return { open, close };
})();

function confirmDialog({ title='Confirmation', message='', ok='Confirmer', danger=false } = {}){
  return new Promise(res => {
    Modal.open({
      title, body:`<p style="font-size:14px;line-height:1.65">${message}</p>`,
      footer:`<button class="btn btn-ghost" data-mclose>Annuler</button>
              <button class="btn ${danger?'btn-danger':'btn-primary'}" data-ok>${esc(ok)}</button>`,
      onClose: () => res(false),
      onMount(ov){
        ov.querySelector('[data-ok]').addEventListener('click', e => { e.preventDefault(); res(true); Modal.close(); });
      }
    });
  });
}

/* Export CSV via Blob (Excel : BOM UTF-8 + séparateur « ; »). */
function exportCSV(filename, headers, rows){
  const cell = v => '"' + String(v ?? '').replace(/"/g,'""') + '"';
  const csv = '\uFEFF' + [headers, ...rows].map(r => r.map(cell).join(';')).join('\r\n');
  const blob = new Blob([csv], { type:'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href), 2000);
  toast(`Export CSV généré : ${filename}`, 'success');
}

/* Aides de rendu partagées */
const roomLabel = r => r ? `${r.bloc.replace('Bloc ','')}-${r.numero}` : '—';
const occupancyIndexes = new WeakMap();
function occupantIds(snap, roomId){
  let occupantsByRoom=occupancyIndexes.get(snap);
  if(!occupantsByRoom){
    occupantsByRoom=createOccupancyIndex(snap.students);
    occupancyIndexes.set(snap,occupantsByRoom);
  }
  return occupantsByRoom.get(roomId)||[];
}
function roomDerivedStatus(snap, r){
  if (r.statut === 'hors_service') return 'hs';
  return occupantIds(snap, r.id).length >= r.capacite ? 'complet' : 'disponible';
}
const BLOCK_TONE_PALETTE = [
  '#167f72',
  '#b97808',
  '#397da8',
  '#8650a0',
  '#b55353',
  '#6f8d2e'
];
const BLOCK_GENDER_LABEL_COLORS = { fille:'#c45b8a', garcon:'#4d83b5', mixte:'#7d8986' };
function blockGenderColor(genre){
  return residenceGenderType()==='mixte'
    ? BLOCK_GENDER_LABEL_COLORS[genre]||BLOCK_GENDER_LABEL_COLORS.mixte
    : '#6b7280';
}
const BLOC_BADGE = { entree:['b-ok','Entrée'], sortie:['b-bad','Sortie'], transfert:['b-info','Transfert'] };
const REC_STATUT_BADGE = { nouvelle:['b-info','Nouvelle'], en_cours:['b-warn','En cours'], resolue:['b-ok','Résolue'], rejetee:['b-neutral','Rejetée'] };
const PRIO_BADGE = { haute:['b-bad','Haute'], moyenne:['b-warn','Moyenne'], basse:['b-neutral','Basse'] };
const b = ([cls,txt]) => `<span class="badge ${cls}">${txt}</span>`;

/* ══════════════ SECTION 7 — GRAPHIQUES CANVAS (vanilla) ══════════════ */
function prepCanvas(cv){
  const dpr = window.devicePixelRatio || 1;
  const rect = cv.getBoundingClientRect();
  cv.width = Math.max(1, rect.width * dpr);
  cv.height = Math.max(1, rect.height * dpr);
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr,0,0,dpr,0,0);
  return { ctx, w: rect.width, h: rect.height };
}
function animate(cv, draw){
  if (cv._anim) cancelAnimationFrame(cv._anim);
  const t0 = performance.now(), D = 680;
  const step = now => {
    const t = Math.min(1, (now - t0) / D);
    draw(1 - Math.pow(1 - t, 3));              // easing cubic-out
    if (t < 1) cv._anim = requestAnimationFrame(step); else cv._anim = null;
  };
  cv._anim = requestAnimationFrame(step);
}
function rrect(ctx,x,y,w,h,r){
  r = Math.max(0, Math.min(r, w/2, h/2));
  ctx.beginPath();
  ctx.moveTo(x+r,y);
  ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r);
  ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r);
  ctx.closePath();
}
/* Histogramme — valeurs normalisées 0..1 (taux) */
function drawBarChart(cv, items){
  const darkMode=document.body.classList.contains('dark-mode');
  if (!items.length){ const {ctx,w,h}=prepCanvas(cv); ctx.fillStyle=darkMode?'#adb9bf':'#67797a'; ctx.textAlign='center'; ctx.font='13px '+getComputedStyle(document.body).fontFamily; ctx.fillText('Aucune donnée', w/2, h/2); return; }
  animate(cv, e => {
    const {ctx,w,h} = prepCanvas(cv);
    const padL=40, padR=8, padT=16, padB=30;
    const plotW=w-padL-padR, plotH=h-padT-padB;
    ctx.font='11px '+getComputedStyle(document.body).fontFamily;
    for (let g=0; g<=4; g++){
      const y = padT + plotH*(1-g/4);
      ctx.strokeStyle=darkMode?'#3a454b':'#e2e8e4'; ctx.lineWidth=1;
      ctx.beginPath(); ctx.moveTo(padL,y); ctx.lineTo(w-padR,y); ctx.stroke();
      ctx.fillStyle=darkMode?'#adb9bf':'#8a9a96'; ctx.textAlign='right'; ctx.fillText((g*25)+'%', padL-7, y+4);
    }
    const slot = plotW / items.length;
    const bw = Math.min(52, slot*0.52);
    items.forEach((it,i)=>{
      const cx = padL + slot*(i+0.5);
      const bh = plotH * Math.min(1,it.value) * e;
      ctx.fillStyle=it.barColor||'#157a6d';
      if (bh>1){ rrect(ctx, cx-bw/2, padT+plotH-bh, bw, bh, 4); ctx.fill(); }
      ctx.fillStyle=darkMode?'#c4cdd1':it.labelColor || '#4d5f5c'; ctx.textAlign='center';
      ctx.fillText(it.label, cx, h-10);
      if (e>0.97){ ctx.fillStyle=darkMode?'#e1e8eb':it.labelColor || '#0b463f'; ctx.font='bold 11px '+getComputedStyle(document.body).fontFamily;
        ctx.fillText(it.txt, cx, padT+plotH-bh-6); ctx.font='11px '+getComputedStyle(document.body).fontFamily; }
    });
    ctx.strokeStyle=darkMode?'#64737a':'#c8d2cd'; ctx.beginPath(); ctx.moveTo(padL,padT+plotH); ctx.lineTo(w-padR,padT+plotH); ctx.stroke();
  });
}
/* Petite jauge circulaire (KPI occupation) */
function drawGauge(cv, ratio){
  animate(cv, e => {
    const {ctx,w,h} = prepCanvas(cv);
    if(Math.min(w,h)<=10) return;
    const cx=w/2, cy=h/2, R=Math.min(w,h)/2-5;
    ctx.lineWidth=6; ctx.lineCap='round';
    const darkMode=document.body.classList.contains('dark-mode');
    ctx.strokeStyle=darkMode?'#3a454b':'#e4eae6';
    ctx.beginPath(); ctx.arc(cx,cy,R,0,7); ctx.stroke();
    ctx.strokeStyle=darkMode?'#69b6aa':'#0f5e54';
    ctx.beginPath(); ctx.arc(cx,cy,R,-Math.PI/2,-Math.PI/2 + Math.PI*2*Math.min(1,ratio)*e); ctx.stroke();
  });
}
function countUp(el, target, suffix=''){
  const t0 = performance.now(), D = 750;
  const step = now => {
    const t = Math.min(1,(now-t0)/D), e = 1-Math.pow(1-t,3);
    el.textContent = Math.round(target*e) + suffix;
    if (t<1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* ══════════════ SECTION 8 — ROUTEUR / NAVIGATION ══════════════ */
let currentView = 'dashboard';
let currentStudentFicheId = null;
function showView(name){
  if (!VIEWS[name] || name==='complaints' || (name==='users' && !isAdmin()) || (name==='history' && !isAdmin()) || (name==='import' && !isAdmin())) name='dashboard';
  currentView = name;
  document.querySelectorAll('.view').forEach(v => v.hidden = true);
  $('view-'+name).hidden = false;
  $('view-'+name).style.animation='none';            // relance l'animation d'entrée
  void $('view-'+name).offsetWidth;
  $('view-'+name).style.animation='';
  document.querySelectorAll('.nav-item').forEach(ni =>
    ni.classList.toggle('active', ni.dataset.nav === name));
  $('tb-title').textContent = VIEWS[name][0];
  /* Bouton d'action contextuel */
  const qa = $('tb-action');
  const quick = { students:['Nouveau résident','new-student'], rooms:['Nouvelle chambre','new-room'],
                  users:['Nouvel utilisateur','new-user'] }[name];
  if (name==='students'){
    $('students-table-actions').insertBefore(qa,$('students-export-control'));
    qa.hidden=false; qa.dataset.action=quick[1]; qa.innerHTML=Icons.plus+quick[0];
  } else {
    $('tb-date').before(qa);
    if (quick && name!=='rooms' && (name!=='users' || isAdmin())){
    qa.hidden=false; qa.dataset.action=quick[1]; qa.innerHTML = Icons.plus + quick[0];
    } else qa.hidden=true;
  }
  safe(renderCurrentAndRefreshNavigation);
}
async function renderCurrent(){
  await ({ dashboard: renderDashboard, reports: renderReports, students: renderStudents, rooms: renderRooms,
    'renewal-tracking': renderRenewalTracking, 'student-detail': renderStudentFichePage, history: renderHistory, users: renderUsers, settings: renderSettings, import: renderImportWizard }[currentView])();
}
async function renderCurrentAndRefreshNavigation(){
  if(currentView==='renewal-tracking'){
    await renderCurrent();
    return;
  }
  await snapshotScope.run(async snap=>{
    await renderCurrent();
  });
}
async function refresh(){ await renderCurrentAndRefreshNavigation(); }

/* ══════════════ SECTION 9 — RAPPORTS & STATISTIQUES ══════════════ */
function reportBars(items){
  const max=Math.max(1,...items.map(item=>item.ratio===undefined?item.value:1));
  return `<div class="report-bars">${items.map(item=>{
    const ratio=Math.max(0,Math.min(1,(item.ratio??item.value)/max));
    const label=item.blockName
      ? `<button type="button" class="report-bar-label report-bar-select" data-report-block="${esc(item.blockName)}" aria-pressed="${item.selected?'true':'false'}" title="Filtrer le détail sur ${esc(item.label)}">${esc(item.label)}</button>`
      : `<span class="report-bar-label">${esc(item.label)}</span>`;
    return `<div class="report-bar-row">${label}
      <span class="report-bar-track"><span class="report-bar-fill" style="width:${Math.round(ratio*100)}%;--bar-color:${item.color||'var(--brand)'}"></span></span>
      <span class="report-bar-value">${esc(item.valueLabel??String(item.value))}</span></div>`;
  }).join('')}</div>`;
}
function reportStat(label,value,sub=''){ return `<div class="report-kpi"><div class="lbl">${esc(label)}</div><div class="val">${esc(String(value))}</div><div class="sub">${esc(sub)}</div></div>`; }
function reportSegments(items,total){
  const segments=items.filter(item=>item.value>0);
  return `<div class="report-segment-track" role="img" aria-label="${esc(items.map(item=>`${item.label} : ${item.value}`).join(', '))}">
      ${segments.map(item=>`<span class="report-segment" style="width:${total?item.value/total*100:0}%;--segment-color:${item.color}"></span>`).join('')}
    </div><div class="report-legend">${items.map(item=>`<div class="report-legend-item"><span class="report-legend-dot" style="--segment-color:${item.color}"></span><span>${esc(item.label)}</span><b>${item.value.toLocaleString('fr-FR')}</b></div>`).join('')}</div>`;
}
const REPORT_CARD_ORDER_KEY='hebergia_report_card_order_v2';
const REPORT_CARD_HIDDEN_KEY='hebergia_report_card_hidden_v3';
const REPORT_CARD_SPANS_KEY='hebergia_report_card_spans_v2';
const DEFAULT_REPORT_CARD_ORDER=['capacity','rooms','block-occupancy','faculties','gender','renewals','complaint-status','complaint-age','movements','block-detail'];
const DEFAULT_HIDDEN_REPORT_CARDS=['complaint-status','complaint-age'];
function getReportCardOrder(){
  const stored=localStorage.getItem(REPORT_CARD_ORDER_KEY);
  const order=stored?stored.split(','):[];
  const validOrder=[...new Set(order.filter(id=>DEFAULT_REPORT_CARD_ORDER.includes(id)))];
  return [...validOrder,...DEFAULT_REPORT_CARD_ORDER.filter(id=>!validOrder.includes(id))];
}
function arrangeReportCards(root,order=getReportCardOrder()){
  const cards=new Map([...root.querySelectorAll('.report-grid > .report-card')].map(card=>[card.dataset.reportCard,card]));
  order.forEach(id=>{const card=cards.get(id);if(card) root.querySelector('.report-grid').append(card);});
}
function saveReportCardOrder(root){
  const order=[...root.querySelectorAll('.report-grid > .report-card')].map(card=>card.dataset.reportCard);
  localStorage.setItem(REPORT_CARD_ORDER_KEY,order.join(','));
  return order;
}
function getHiddenReportCards(){
  const stored=localStorage.getItem(REPORT_CARD_HIDDEN_KEY);
  return new Set((stored===null?DEFAULT_HIDDEN_REPORT_CARDS:stored.split(','))
    .filter(id=>DEFAULT_REPORT_CARD_ORDER.includes(id)));
}
function getReportCardSpans(){
  const spans=new Map(DEFAULT_REPORT_CARD_ORDER.map(id=>[id,['movements','block-detail'].includes(id)?12:6]));
  (localStorage.getItem(REPORT_CARD_SPANS_KEY)||'').split(',').forEach(entry=>{
    const [id,value]=entry.split(':');
    const span=Number(value);
    if(spans.has(id)&&Number.isInteger(span)&&span>=4&&span<=12) spans.set(id,span);
  });
  return spans;
}
function saveReportCardLayout(root){
  saveReportCardOrder(root);
  const hidden=[...root.querySelectorAll('.report-grid > .report-card[hidden]')].map(card=>card.dataset.reportCard);
  localStorage.setItem(REPORT_CARD_HIDDEN_KEY,hidden.join(','));
  const spans=[...root.querySelectorAll('.report-grid > .report-card')].map(card=>`${card.dataset.reportCard}:${Number(card.style.getPropertyValue('--report-card-span'))||6}`);
  localStorage.setItem(REPORT_CARD_SPANS_KEY,spans.join(','));
}
function moveReportCard(root,source,target,after=false){
  if(!source||!target||source===target) return false;
  target.parentElement.insertBefore(source,after?target.nextSibling:target);
  const order=[...root.querySelectorAll('.report-grid > .report-card')].filter(card=>!card.hidden);
  saveReportCardLayout(root);
  const status=root.querySelector('[data-report-drag-status]');
  const title=source.querySelector('h3')?.textContent||'Carte';
  status.textContent=`${title} déplacée à la position ${order.findIndex(card=>card===source)+1} sur ${order.length}.`;
  return true;
}
function reportCardAtPoint(root,x,y){
  return [...root.querySelectorAll('.report-grid > .report-card:not([hidden])')].find(card=>{
    const bounds=card.getBoundingClientRect();
    return x>=bounds.left&&x<=bounds.right&&y>=bounds.top&&y<=bounds.bottom;
  })||null;
}
function renderReportLayoutToolbar(root){
  const toolbar=root.querySelector('#reports-layout-toolbar');
  if(!ReportsView.layoutEditing){
    toolbar.innerHTML='<button type="button" class="btn btn-ghost btn-sm" data-report-layout-toggle>Modifier la disposition</button>';
    return;
  }
  const hiddenCards=[...root.querySelectorAll('.report-grid > .report-card[hidden]')];
  toolbar.innerHTML=`<div class="report-layout-toolbar" role="toolbar" aria-label="Personnaliser les blocs du rapport">
    <p><strong>Mode de mise en page</strong> · Glissez les titres pour déplacer les cartes et leur bord droit pour ajuster la largeur.</p>
    <button type="button" class="btn btn-ghost btn-sm" data-report-layout-reset>Réinitialiser</button>
    <button type="button" class="btn btn-primary btn-sm" data-report-layout-done>Terminer</button>
    ${hiddenCards.length?`<div class="report-layout-additions"><span class="report-layout-additions-label">Ajouter un bloc :</span>${hiddenCards.map(card=>`<button type="button" class="btn btn-ghost btn-sm" data-report-show-card="${esc(card.dataset.reportCard)}">+ ${esc(card.querySelector('h3')?.textContent||'Bloc')}</button>`).join('')}</div>`:''}
  </div>`;
}
const ReportsView={movementMonths:6,selectedBlock:null,layoutEditing:false};
async function renderReports(){
  const snap=await snapshot(), rooms=Scope.rooms(snap), active=snap.students.filter(student=>student.statut==='actif');
  const roomById=new Map(rooms.map(room=>[room.id,room]));
  const usable=rooms.filter(room=>room.statut!=='hors_service');
  const outOfService=rooms.length-usable.length;
  const usableRoomIds=new Set(usable.map(room=>room.id));
  const assigned=active.filter(student=>student.chambreId&&roomById.has(student.chambreId));
  const housed=assigned.filter(student=>usableRoomIds.has(student.chambreId));
  const inOutOfService=assigned.length-housed.length;
  const unassigned=active.length-assigned.length;
  const beds=usable.reduce((sum,room)=>sum+room.capacite,0);
  const occupied=housed.length;
  const freeBeds=Math.max(0,beds-occupied);
  const overCapacity=Math.max(0,occupied-beds);
  const occupancy=beds?Math.min(1,occupied/beds):0;
  const complaints=Scope.complaints(snap);
  const openComplaints=complaints.filter(complaint=>complaint.statut==='nouvelle'||complaint.statut==='en_cours');
  const blockNames=[...new Set(rooms.map(room=>room.bloc))].sort(compareNames);
  const blockStats=blockNames.map(name=>{
    const blockRooms=usable.filter(room=>room.bloc===name);
    const roomIds=new Set(blockRooms.map(room=>room.id));
    const capacity=blockRooms.reduce((sum,room)=>sum+room.capacite,0);
    const residents=housed.filter(student=>roomIds.has(student.chambreId)).length;
    const availableRooms=blockRooms.filter(room=>roomDerivedStatus(snap,room)==='disponible').length;
    const rate=capacity?residents/capacity:0;
    return {name,rooms:blockRooms.length,capacity,residents,free:Math.max(0,capacity-residents),rate,availableRooms,color:rate>=0.95?'#b97808':'#167f72'};
  });
  const roomCounts={
    full:usable.filter(room=>roomDerivedStatus(snap,room)==='complet').length,
    partial:usable.filter(room=>{const count=occupantIds(snap,room.id).length;return count>0&&count<room.capacite;}).length,
    empty:usable.filter(room=>occupantIds(snap,room.id).length===0).length,
    out:outOfService
  };
  const roomCount=rooms.length;
  const genderCounts={fille:0,garcon:0,unknown:0};
  active.forEach(student=>{
    const gender=residentGender(student.sexe);
    if(gender==='fille') genderCounts.fille++;
    else if(gender==='garcon') genderCounts.garcon++;
    else genderCounts.unknown++;
  });
  const facultyCounts=new Map();
  active.forEach(student=>{
    const faculty=String(student.faculte||'').trim()||'Non renseignée';
    facultyCounts.set(faculty,(facultyCounts.get(faculty)||0)+1);
  });
  const sortedFaculties=[...facultyCounts].sort((a,b)=>b[1]-a[1]||compareNames(a[0],b[0]));
  const facultyLimit=6;
  const topFaculties=sortedFaculties.slice(0,facultyLimit).map(([label,value],index)=>({label,value,color:BLOCK_TONE_PALETTE[index%BLOCK_TONE_PALETTE.length]}));
  if(sortedFaculties.length>facultyLimit){
    topFaculties.push({label:'Autres formations',value:sortedFaculties.slice(facultyLimit).reduce((sum,[,value])=>sum+value,0),color:'#82909a'});
  }
  const complaintTypes=TYPES_REC.map(([key,label],index)=>({
    label,value:openComplaints.filter(complaint=>complaint.type===key).length,
    color:['#c2574a','#b97808','#397da8','#8650a0','#167f72','#6f8d2e'][index%6]
  })).filter(item=>item.value>0);
  const complaintStatus=[
    {label:'Nouvelles',value:complaints.filter(complaint=>complaint.statut==='nouvelle').length,color:'#397da8'},
    {label:'En cours',value:complaints.filter(complaint=>complaint.statut==='en_cours').length,color:'#b97808'},
    {label:'Résolues',value:complaints.filter(complaint=>complaint.statut==='resolue').length,color:'#16804b'},
    {label:'Rejetées',value:complaints.filter(complaint=>complaint.statut==='rejetee').length,color:'#82909a'}
  ];
  const reportNow=new Date();
  const complaintAgeBuckets=[
    {label:'Moins de 2 jours',value:0,color:'#16804b'},
    {label:'2 à 7 jours',value:0,color:'#d8a03d'},
    {label:'Plus de 7 jours',value:0,color:'#c2574a'}
  ];
  let undatedOpenComplaints=0;
  openComplaints.forEach(complaint=>{
    const declaredAt=Date.parse(complaint.declaredAt);
    if(!Number.isFinite(declaredAt)){undatedOpenComplaints++;return;}
    const ageDays=Math.max(0,Math.floor((reportNow.getTime()-declaredAt)/86400000));
    complaintAgeBuckets[ageDays<2?0:ageDays<=7?1:2].value++;
  });
  const resolutionDurations=complaints.filter(complaint=>complaint.statut==='resolue').map(complaint=>{
    const declaredAt=Date.parse(complaint.declaredAt),resolvedAt=Date.parse(complaint.resolvedAt);
    return Number.isFinite(declaredAt)&&Number.isFinite(resolvedAt)&&resolvedAt>=declaredAt
      ? (resolvedAt-declaredAt)/86400000 : null;
  }).filter(duration=>duration!==null).sort((a,b)=>a-b);
  const middle=Math.floor(resolutionDurations.length/2);
  const medianResolutionDays=resolutionDurations.length
    ? (resolutionDurations.length%2?resolutionDurations[middle]:(resolutionDurations[middle-1]+resolutionDurations[middle])/2)
    : null;
  const complaintsByBlock=[...new Set(openComplaints.map(complaint=>complaint.bloc||'Bloc non renseigné'))]
    .map(name=>({name,count:openComplaints.filter(complaint=>(complaint.bloc||'Bloc non renseigné')===name&&complaint.priorite==='haute').length}))
    .filter(block=>block.count>0).sort((a,b)=>b.count-a.count||compareNames(a.name,b.name)).slice(0,5);
  const movementSeries=[
    {key:'entree',label:'Entrées',color:'#16804b'},
    {key:'sortie',label:'Sorties',color:'#c2574a'},
    {key:'transfert',label:'Transferts',color:'#397da8'}
  ];
  const historyForReport=Scope.history(snap);
  const movementMonths=summarizeMonthlyMovements(historyForReport,reportNow,ReportsView.movementMonths);
  const movementMax=Math.max(1,...movementMonths.flatMap(month=>movementSeries.map(series=>month[series.key])));
  const movementRows=movementMonths.map(month=>`<div class="report-movement-row"><span class="report-movement-month">${esc(month.label)}</span>
    ${movementSeries.map(series=>`<div class="report-movement-cell"><span>${esc(series.label)}</span><b>${month[series.key]}</b>
      <span class="report-bar-track"><span class="report-bar-fill" style="width:${Math.round(month[series.key]/movementMax*100)}%;--bar-color:${series.color}"></span></span></div>`).join('')}
    </div>`).join('');
  const annualYear=currentAcademicYear();
  const annualCampaign=(snap.renewalCampaigns||[]).find(campaign=>campaign.academicYear===annualYear);
  const renewalRows=active.map(student=>({
    status:renewalDossierDisplayStatus((snap.housingDossiers||[]).find(dossier=>dossier.studentId===student.id&&dossier.academicYear===annualYear),annualCampaign?.status)
  }));
  const renewalStatusOptions=HOUSING_DOSSIER_STATUSES.filter(([status])=>status!=='clos'
    &&(status!=='a_renouveler'||annualCampaign?.status==='ouverte')
    &&!(annualCampaign?.status==='cloturee'&&RENEWAL_PENDING_STATUSES.includes(status)))
    .map(([status,label],index)=>({
    label,value:renewalRows.filter(row=>row.status===status).length,
    color:['#82909a','#397da8','#c88b18','#8650a0','#16804b','#c2574a'][index]
  }));
  const renewalStatuses=[
    ...(renewalRows.some(row=>row.status==='clos_sans_decision')?[{label:'Clôturés sans décision',value:renewalRows.filter(row=>row.status==='clos_sans_decision').length,color:'#c88b18'}]:[]),
    ...(renewalRows.some(row=>row.status==='non_ouverte')?[{label:'Campagne non ouverte',value:renewalRows.filter(row=>row.status==='non_ouverte').length,color:'#82909a'}]:[]),
    ...renewalStatusOptions
  ];
  const renewalAccepted=renewalRows.filter(row=>row.status==='accepte').length;
  const movementEventCount=movementMonths.reduce((sum,month)=>sum+movementSeries.reduce((monthSum,series)=>monthSum+month[series.key],0),0);
  const movementNet=movementMonths.reduce((sum,month)=>sum+month.net,0);
  const movementAvailable=isAdmin();
  const roomMix=[
    {label:'Complètes',value:roomCounts.full,color:'#167f72'},
    {label:'Partiellement occupées',value:roomCounts.partial,color:'#397da8'},
    {label:'Vides',value:roomCounts.empty,color:'#d8a03d'},
    {label:'Hors service',value:roomCounts.out,color:'#c2574a'}
  ];
  const ratePercent=beds?`${Math.round(occupancy*100)}%`:'—';
  const selectedBlock=blockStats.some(block=>block.name===ReportsView.selectedBlock)?ReportsView.selectedBlock:null;
  const visibleBlockStats=selectedBlock?blockStats.filter(block=>block.name===selectedBlock):blockStats;
  const blockRows=visibleBlockStats.map(block=>`<tr${selectedBlock===block.name?' class="is-focused"':''}><td class="report-block-name">${esc(block.name)}</td>
    <td class="numeric">${block.rooms.toLocaleString('fr-FR')}</td><td class="numeric">${block.residents.toLocaleString('fr-FR')}</td>
    <td class="numeric">${block.capacity.toLocaleString('fr-FR')}</td><td class="numeric">${block.free.toLocaleString('fr-FR')}</td>
    <td class="numeric report-rate">${block.capacity?`${Math.round(block.rate*100)}%`:'—'}</td>
    <td class="numeric">${block.availableRooms.toLocaleString('fr-FR')}</td></tr>`).join('');
  const generated=fmtDate(nowISO());
  $('tb-sub').textContent=`Synthèse de la résidence · ${rooms.length.toLocaleString('fr-FR')} chambres`;
  $('reports-root').innerHTML=`<header class="report-head">
    <div><h2>Rapport de gestion de la résidence</h2><p>Indicateurs actuels et tendances historiques des mouvements</p></div>
    <span class="spacer"></span><span class="report-generated">Généré le ${esc(generated)}</span>
  </header>
  <div id="reports-layout-toolbar"></div>
  <div class="report-export-row"><div id="reports-export-toolbar"></div></div>
  <div class="report-kpis">
    ${reportStat('Résidents actifs',active.length.toLocaleString('fr-FR'),`${housed.length.toLocaleString('fr-FR')} en chambre utilisable`)}
    ${reportStat('Occupation des lits',ratePercent,`${occupied.toLocaleString('fr-FR')} occupés sur ${beds.toLocaleString('fr-FR')} lits utilisables`)}
    ${reportStat('Lits libres',freeBeds.toLocaleString('fr-FR'),overCapacity?`Capacité dépassée de ${overCapacity} lit${overCapacity===1?'':'s'}`:`Capacité restante · ${beds.toLocaleString('fr-FR')} lits`)}
    ${reportStat('Réclamations ouvertes',openComplaints.length.toLocaleString('fr-FR'),`${complaints.length.toLocaleString('fr-FR')} réclamations au total`)}
  </div>
  <div class="report-grid">
    <section class="card report-card" data-report-card="capacity"><div class="card-h"><h3>Utilisation de la capacité</h3></div><div class="card-b">
      ${beds?reportSegments([
        {label:'Lits occupés',value:Math.min(occupied,beds),color:'#0f5e54'},
        {label:'Lits libres',value:freeBeds,color:'#d8a03d'}
      ],beds):'<div class="report-empty">Aucun lit utilisable enregistré.</div>'}
      ${overCapacity?`<p class="report-note">Attention : ${overCapacity.toLocaleString('fr-FR')} résident${overCapacity===1?'':'s'} au-delà de la capacité déclarée.</p>`:''}
      ${inOutOfService?`<p class="report-note">${inOutOfService.toLocaleString('fr-FR')} résident${inOutOfService===1?'':'s'} affecté${inOutOfService===1?'':'s'} à une chambre hors service ; exclu${inOutOfService===1?'':'s'} du taux d’occupation.</p>`:''}
      ${unassigned?`<p class="report-note">${unassigned.toLocaleString('fr-FR')} résident${unassigned===1?'':'s'} actif${unassigned===1?'':'s'} sans chambre affectée.</p>`:''}
    </div></section>
    <section class="card report-card" data-report-card="rooms"><div class="card-h"><h3>Répartition des chambres</h3></div><div class="card-b">
      ${roomCount?reportSegments(roomMix,roomCount):'<div class="report-empty">Aucune chambre enregistrée.</div>'}
      <p class="report-note">Les chambres hors service sont comptées à part et exclues des lits utilisables.</p>
    </div></section>
    <section class="card report-card" data-report-card="block-occupancy"><div class="card-h"><h3>Occupation par bloc</h3><span class="spacer"></span><span class="report-table-count">Cliquer un bloc pour filtrer</span></div><div class="card-b">
      ${blockStats.length?reportBars(blockStats.map(block=>({label:block.name,blockName:block.name,selected:selectedBlock===block.name,ratio:block.rate,valueLabel:`${block.residents} / ${block.capacity} · ${block.capacity?Math.round(block.rate*100):0}%`,color:block.color}))) :'<div class="report-empty">Aucun bloc avec des chambres enregistrées.</div>'}
      <p class="report-note">Résidents ÷ lits utilisables · accent ocre : occupation ≥ 95 %.</p>
    </div></section>
    <section class="card report-card" data-report-card="gender"><div class="card-h"><h3>Résidents par sexe déclaré</h3></div><div class="card-b">
      ${active.length?reportSegments([
        {label:'Filles',value:genderCounts.fille,color:residenceGenderType()==='mixte'?'#c45b8a':'#374151'},
        {label:'Garçons',value:genderCounts.garcon,color:residenceGenderType()==='mixte'?'#4d83b5':'#6b7280'},
        {label:'Non renseigné',value:genderCounts.unknown,color:'#9ca3af'}
      ],active.length):'<div class="report-empty">Aucun résident actif.</div>'}
      <p class="report-note">Comptage établi à partir du champ « sexe » des dossiers actifs ; les valeurs absentes ou non reconnues sont indiquées séparément.</p>
    </div></section>
    <section class="card report-card" data-report-card="faculties"><div class="card-h"><h3>Formations des résidents actifs</h3></div><div class="card-b">
      ${topFaculties.length?reportBars(topFaculties.map(item=>({label:item.label,value:item.value,valueLabel:item.value.toLocaleString('fr-FR'),color:item.color}))):'<div class="report-empty">Aucune formation renseignée.</div>'}
      <p class="report-note">Principales formations renseignées dans les dossiers actifs${sortedFaculties.length>facultyLimit?' ; les autres sont regroupées.':'.'}</p>
    </div></section>
    <section class="card report-card" data-report-card="complaint-status"><div class="card-h"><h3>Réclamations par statut</h3></div><div class="card-b">
      ${complaints.length?reportSegments(complaintStatus,complaints.length):'<div class="report-empty">Aucune réclamation enregistrée.</div>'}
      ${openComplaints.length?`<div class="sec-title" style="margin-top:17px">Types à traiter</div>${reportBars(complaintTypes.map(item=>({label:item.label,value:item.value,valueLabel:item.value.toLocaleString('fr-FR'),color:item.color})))}`:''}
    </div></section>
    <section class="card report-card" data-report-card="complaint-age"><div class="card-h"><h3>Ancienneté des réclamations ouvertes</h3></div><div class="card-b">
      ${openComplaints.length?(openComplaints.length>undatedOpenComplaints?reportSegments(complaintAgeBuckets,openComplaints.length-undatedOpenComplaints):'<div class="report-empty">Dates de déclaration indisponibles.</div>'):'<div class="report-empty">Aucune réclamation ouverte.</div>'}
      ${medianResolutionDays!==null?`<p class="report-note">Délai médian de résolution : <strong>${medianResolutionDays.toLocaleString('fr-FR',{maximumFractionDigits:1})} j</strong> · ${resolutionDurations.length} réclamation${resolutionDurations.length===1?'':'s'} résolue${resolutionDurations.length===1?'':'s'} avec dates valides.</p>`:'<p class="report-note">Délai médian indisponible : aucune résolution avec des dates valides.</p>'}
      ${undatedOpenComplaints?`<p class="report-note">${undatedOpenComplaints} réclamation${undatedOpenComplaints===1?'':'s'} ouverte${undatedOpenComplaints===1?'':'s'} exclue${undatedOpenComplaints===1?'':'s'} de la répartition faute de date valide.</p>`:''}
      ${complaintsByBlock.length?`<div class="sec-title" style="margin-top:14px">Priorité haute par bloc</div>${reportBars(complaintsByBlock.map(block=>({label:block.name,value:block.count,valueLabel:String(block.count),color:'#c2574a'})))}`:''}
    </div></section>
    <section class="card report-card" data-report-card="movements"><div class="card-h"><h3>Mouvements des ${ReportsView.movementMonths} derniers mois</h3><span class="spacer"></span><label class="report-period-control">Période
      <select class="inp" data-report-movement-months aria-label="Période des mouvements">${[3,6,12].map(months=>`<option value="${months}"${ReportsView.movementMonths===months?' selected':''}>${months} mois</option>`).join('')}</select></label></div><div class="card-b">
      ${movementAvailable?`<div class="report-movement-legend">${movementSeries.map(series=>`<span><i class="report-movement-dot" style="--movement-color:${series.color}"></i>${esc(series.label)}</span>`).join('')}</div>
        ${movementEventCount?movementRows:'<div class="report-empty">Aucun mouvement enregistré sur la période.</div>'}
        ${movementEventCount?`<p class="report-movement-net">Solde des entrées/sorties sur la période : ${movementNet>0?'+':''}${movementNet} résident${Math.abs(movementNet)===1?'':'s'} · transferts exclus du solde.</p>`:''}`
        :'<div class="report-empty">Historique des mouvements indisponible pour ce profil.</div>'}
    </div></section>
    <section class="card report-card" data-report-card="renewals"><div class="card-h"><h3>Renouvellements · ${esc(annualYear)}</h3></div><div class="card-b">
      ${active.length?reportSegments(renewalStatuses,active.length):'<div class="report-empty">Aucun résident actif pour cette année universitaire.</div>'}
      ${active.length?`<p class="report-note">${renewalAccepted.toLocaleString('fr-FR')} dossier${renewalAccepted===1?'':'s'} accepté${renewalAccepted===1?'':'s'} sur ${active.length.toLocaleString('fr-FR')} résidents actifs · ${Math.round(renewalAccepted/active.length*100)} %.</p>`:''}
      <p class="report-note">${annualCampaign?.status==='ouverte'?'Les dossiers absents sont comptés « À renouveler », comme dans le suivi annuel.':annualCampaign?.status==='cloturee'?'Les dossiers non finalisés sont affichés « Clôturés sans décision ».':'« À renouveler » n’est affiché que lorsque la campagne est ouverte.'}</p>
    </div></section>
    <section class="card report-card report-card-full" data-report-card="block-detail"><div class="card-h"><h3 id="report-block-detail-title" tabindex="-1">Détail par bloc</h3><span class="spacer"></span><div class="report-detail-tools">${selectedBlock?`<span class="report-table-count">Filtré sur ${esc(selectedBlock)} · 1 bloc affiché</span><button type="button" class="btn btn-ghost btn-sm report-clear-filter" data-report-clear-block>Tout afficher</button>`:`<span class="report-table-count">${blockStats.length} blocs · cliquez sur un bloc ci-dessus pour filtrer</span>`}</div></div><div class="card-b">
      ${blockStats.length?`<div class="report-table-wrap"><table class="report-table"><thead><tr><th>Bloc</th><th class="numeric">Chambres</th><th class="numeric">Résidents</th><th class="numeric">Lits utilisables</th><th class="numeric">Lits libres</th><th class="numeric">Occupation</th><th class="numeric">Chambres avec places</th></tr></thead><tbody>${blockRows}</tbody></table></div>`:'<div class="report-empty">Aucun bloc avec des chambres enregistrées.</div>'}
      <p class="report-note">Les chambres hors service sont exclues des lits et taux d’occupation. « Chambres avec places » inclut les chambres vides et partiellement occupées.</p>
    </div></section>
  </div>
  <p class="report-footnote">Les indicateurs d’occupation et de dossiers décrivent la situation actuelle. La période choisie s’applique au graphique des mouvements. Rapport calculé à partir des données enregistrées dans HÉBERGIA · ${esc(generated)}.</p>
  <p class="report-drag-status" role="status" aria-live="polite" data-report-drag-status></p>`;
  const reportRoot=$('reports-root');
  arrangeReportCards(reportRoot);
  const hiddenCards=getHiddenReportCards(),cardSpans=getReportCardSpans();
  reportRoot.classList.toggle('report-layout-editing',ReportsView.layoutEditing);
  reportRoot.querySelectorAll('.report-grid > .report-card').forEach(card=>{
    const id=card.dataset.reportCard;
    const title=card.querySelector('h3')?.textContent||'Carte';
    const titleElement=card.querySelector('h3');
    card.hidden=hiddenCards.has(id);
    card.style.setProperty('--report-card-span',cardSpans.get(id));
    titleElement.draggable=false;
    titleElement.tabIndex=ReportsView.layoutEditing?0:-1;
    titleElement.setAttribute('aria-label',ReportsView.layoutEditing
      ? `Déplacer la carte « ${title} » par glisser-déposer, ou utiliser les flèches ↑ et ↓`
      : title);
    titleElement.title=ReportsView.layoutEditing?'Glisser-déposer ou utiliser les flèches ↑ et ↓':'';
    if(ReportsView.layoutEditing){
      const actions=document.createElement('div');
      actions.className='report-card-actions';
      actions.innerHTML=`<button type="button" class="report-card-action" data-report-hide-card="${esc(id)}" aria-label="Retirer le bloc « ${esc(title)} »" title="Retirer du rapport">×</button>`;
      card.querySelector('.card-h').append(actions);
      const resizeHandle=document.createElement('button');
      resizeHandle.type='button';
      resizeHandle.className='report-resize-handle';
      resizeHandle.dataset.reportResize=id;
      resizeHandle.setAttribute('role','separator');
      resizeHandle.setAttribute('aria-orientation','vertical');
      resizeHandle.setAttribute('aria-label',`Redimensionner le bloc « ${title} »`);
      resizeHandle.setAttribute('aria-keyshortcuts','ArrowLeft ArrowRight');
      resizeHandle.setAttribute('aria-valuemin','4');
      resizeHandle.setAttribute('aria-valuemax','12');
      resizeHandle.setAttribute('aria-valuenow',String(cardSpans.get(id)));
      resizeHandle.title='Glisser pour redimensionner · flèches ← et →';
      card.append(resizeHandle);
    }
  });
  renderReportLayoutToolbar(reportRoot);
  $('reports-export-toolbar').innerHTML=`<div class="reports-export-actions">${exportControlMarkup('reports','view-export')}<button class="btn btn-ghost report-pdf-button" type="button" data-action="report-pdf">Exporter en PDF</button></div>`;
}

/* ══════════════ SECTION 10 — MODULE TABLEAU DE BORD ══════════════ */
async function renderDashboard(){
  const snap = await snapshot();
  const rooms = Scope.rooms(snap);
  const roomIds = new Set(rooms.map(r=>r.id));
  const housed = snap.students.filter(s => s.chambreId && roomIds.has(s.chambreId) && s.statut==='actif');
  const activeStudents = snap.students.filter(s=>s.statut==='actif');
  const activeInScope = activeStudents.filter(s=>s.chambreId && roomIds.has(s.chambreId));
  const renewalYear = currentAcademicYear();
  const bacYear = academicYearStart(renewalYear);
  const newBachelors = (isAdmin()?activeStudents:activeInScope)
    .filter(student=>bacYear!==null&&Number(student.anneeBac)===bacYear).length;
  const dossiersByStudent = new Map((snap.housingDossiers||[])
    .filter(dossier=>dossier.academicYear===renewalYear)
    .map(dossier=>[dossier.studentId,dossier]));
  const renewalStudents = isAdmin()?activeStudents:activeInScope;
  const renewalStatusCounts = Object.fromEntries([...HOUSING_DOSSIER_STATUSES.map(([status])=>status),'clos_sans_decision','non_ouverte'].map(status=>[status,0]));
  renewalStudents.forEach(student=>{
    const status=renewalDossierDisplayStatus(dossiersByStudent.get(student.id),activeAcademicPeriod.campaignStatus);
    if(status in renewalStatusCounts) renewalStatusCounts[status]++;
  });
  const pendingRenewals = renewalStudents.filter(student=>{
    const status=renewalDossierDisplayStatus(dossiersByStudent.get(student.id),activeAcademicPeriod.campaignStatus);
    return ['a_renouveler','en_preparation','incomplet','soumis'].includes(status);
  }).length;
  const unassigned = isAdmin()
    ? activeStudents.filter(s=>!s.chambreId || !roomIds.has(s.chambreId)).length
    : null;
  const beds = rooms.filter(r=>r.statut!=='hors_service').reduce((a,r)=>a+r.capacite,0);
  const usableRooms = rooms.filter(r=>r.statut!=='hors_service');
  const hsRooms = rooms.length-usableRooms.length;
  const dispo = usableRooms.filter(r=>roomDerivedStatus(snap,r)==='disponible').length;
  const fullRooms = usableRooms.filter(r=>roomDerivedStatus(snap,r)==='complet').length;
  const occ = beds ? housed.length/beds : 0;
  const freeBeds = beds-housed.length;
  const priorityItems = [
    ...(freeBeds < 0 ? [{label:'Capacité dépassée', value:`${Math.abs(freeBeds)} ${Math.abs(freeBeds)===1?'lit':'lits'}`, tone:'bad', action:'rooms'}] : []),
    ...(activeAcademicPeriod.renewalsOpen&&pendingRenewals ? [{label:'Renouvellements à suivre', value:String(pendingRenewals), tone:'warn', action:'renewal-tracking'}] : []),
    ...(unassigned!==null&&unassigned>0 ? [{label:'Résidents sans chambre', value:String(unassigned), tone:'warn', action:'students'}] : []),
    ...(hsRooms>0 ? [{label:'Chambres hors service', value:String(hsRooms), tone:'warn', action:'rooms'}] : [])
  ];

  const scopeTag = isAdmin() ? '' : ` · ${Session.bloc()}`;
  $('dashboard-priority').innerHTML = priorityItems.length
    ? priorityItems.map(item => `<button class="dashboard-priority-item" type="button" data-tone="${item.tone}" data-nav-go="${item.action}" aria-label="${esc(item.label)} : ${esc(item.value)}"><strong>${esc(item.value)}</strong>${esc(item.label)}</button>`).join('')
    : '<span class="dashboard-priority-empty">Aucun point de vigilance</span>';
  $('tb-sub').textContent = isAdmin()
    ? `Toute la résidence · ${snap.rooms.length} chambres au total`
    : `Périmètre : ${Session.bloc()} · ${rooms.length} chambres`;
  countUp($('k-occ'), Math.round(occ*100), '%');
  $('k-occ-sub').textContent = `${housed.length} lit${housed.length>1?'s':''} occupé${housed.length>1?'s':''} / ${beds}${scopeTag}`;
  drawGauge($('k-gauge'), occ);
  countUp($('k-heb'), housed.length);
  $('k-heb-sub').textContent = isAdmin()
    ? `sur ${activeStudents.length} résidents actifs`
    : `sur ${activeInScope.length} résidents actifs dans ${Session.bloc()}`;
  countUp($('k-beds-free'), Math.max(0,freeBeds));
  $('k-beds-free-sub').textContent = freeBeds<0
    ? `Dépassement de capacité : ${Math.abs(freeBeds)} lit${freeBeds===-1?'':'s'}`
    : `sur ${beds} lits utilisables`;
  $('k-beds-free').closest('.kpi').classList.toggle('k-warn',freeBeds<0);
  $('k-beds-free').closest('.kpi').classList.toggle('k-info',freeBeds>=0);
  countUp($('k-dispo'), dispo);
  $('k-dispo-sub').textContent = `avec au moins un lit libre · ${hsRooms} hors service`;
  countUp($('k-new-bachelors'), newBachelors);
  $('k-new-bachelors-sub').textContent = bacYear===null
    ? 'Année du baccalauréat indisponible'
    : `Baccalauréat ${bacYear} · résidents actifs`;
  countUp($('k-beds-usable'), beds);
  $('k-beds-usable-sub').textContent = `Capacité des chambres en service · ${hsRooms} hors service`;
  $('dash-renewal-period').textContent = `Période ${renewalYear} · ${activeAcademicPeriod.renewalsOpen?'ouverte':'fermée'}`;
  $('dash-renewal-period').className = `badge ${activeAcademicPeriod.renewalsOpen?'b-ok':'b-neutral'}`;
  $('dash-renewal-note').textContent = activeAcademicPeriod.renewalsOpen
    ? `${renewalStudents.length.toLocaleString('fr-FR')} résidents actifs dans le périmètre · les dossiers soumis restent en attente de décision.`
    : `${renewalStudents.length.toLocaleString('fr-FR')} résidents actifs dans le périmètre · ${activeAcademicPeriod.campaignStatus==='cloturee'?'campagne clôturée, dossiers non finalisés affichés comme clôturés sans décision.':'campagne non ouverte, suivi informatif.'}`;
  const renewalStages = activeAcademicPeriod.campaignStatus==='cloturee'
    ?[
      {label:'Clôturés sans décision',count:renewalStatusCounts.clos_sans_decision},
      {label:'Acceptés',count:renewalStatusCounts.accepte},
      {label:'Refusés',count:renewalStatusCounts.refuse}
    ]
    :[
    {label:activeAcademicPeriod.renewalsOpen?'À renouveler':'Campagne non ouverte',count:renewalStatusCounts[activeAcademicPeriod.renewalsOpen?'a_renouveler':'non_ouverte']},
    {label:'En préparation',count:renewalStatusCounts.en_preparation},
    {label:'Incomplets',count:renewalStatusCounts.incomplet},
    {label:'Soumis',count:renewalStatusCounts.soumis},
    {label:'Décisions rendues',count:renewalStatusCounts.accepte+renewalStatusCounts.refuse}
  ];
  $('dash-renewal-stages').innerHTML = renewalStages.map(stage=>
    `<button class="dashboard-renewal-stage" type="button" data-nav-go="renewal-tracking" aria-label="${esc(stage.label)} : ${stage.count} dossiers"><strong>${stage.count.toLocaleString('fr-FR')}</strong><span>${esc(stage.label)}</span></button>`
  ).join('');

  /* Histogramme : occupation par bloc (admin) ou par étage (agent) */
  let barItems;
  if (isAdmin()){
    $('dash-bar-title').textContent = 'Taux d\u2019occupation par bloc';
    $('dash-bar-note').textContent = 'Part des lits occupés dans la capacité utilisable de chaque bloc.';
    const blocks = [...new Set(rooms.map(r=>r.bloc))].sort(compareNames);
    barItems = blocks.map((bloc,index)=>{
      const br = usableRooms.filter(r=>r.bloc===bloc);
      const cap = br.reduce((a,r)=>a+r.capacite,0);
      const n = housed.filter(s=>{ const r = rooms.find(x=>x.id===s.chambreId); return r && r.bloc===bloc; }).length;
      const barColor=BLOCK_TONE_PALETTE[index%BLOCK_TONE_PALETTE.length];
      const gender=blockGender(snap,bloc);
      return { label:bloc.replace('Bloc ',''), value: cap?n/cap:0, txt: cap?Math.round(n/cap*100)+'%':'—',
        barColor, labelColor:blockGenderColor(gender) };
    });
  } else {
    $('dash-bar-title').textContent = `Occupation par étage — ${Session.bloc()}`;
    $('dash-bar-note').textContent = 'Part des lits occupés dans la capacité utilisable de chaque étage.';
    const blocIndex=[...new Set(rooms.map(r=>r.bloc))].sort(compareNames).indexOf(Session.bloc());
    const barColor=BLOCK_TONE_PALETTE[(blocIndex<0?0:blocIndex)%BLOCK_TONE_PALETTE.length];
    const gender=blockGender(snap,Session.bloc());
    const floors = [...new Set(usableRooms.map(r=>floorNumber(r.numero)))].sort((a,b)=>a-b);
    barItems = floors.map(floor=>{
      const floorRooms = usableRooms.filter(r=>floorNumber(r.numero)===floor);
      const cap = floorRooms.reduce((total,r)=>total+r.capacite,0);
      const floorRoomIds = new Set(floorRooms.map(r=>r.id));
      const n = housed.filter(s=>floorRoomIds.has(s.chambreId)).length;
      return { label:floorLabel(floor), value: cap?n/cap:0, txt: cap?Math.round(n/cap*100)+'%':'—',
        barColor, labelColor:blockGenderColor(gender) };
    });
  }
  drawBarChart($('ch-bar'), barItems);
  const statusItems = [
    {label:'Lits libres',note:`sur ${beds} lits utilisables`,value:Math.max(0,freeBeds),action:'rooms',attention:freeBeds<0,alert:freeBeds<0},
    {label:'Chambres avec places',note:'Au moins un lit libre',value:dispo,action:'rooms'},
    {label:'Chambres complètes',note:`sur ${usableRooms.length} chambres utilisables`,value:fullRooms,action:'rooms'},
    {label:'Dossiers non finalisés',note:`Période ${renewalYear} · ${activeAcademicPeriod.renewalsOpen?'à traiter':'fermée · consultation'}`,value:pendingRenewals,action:'renewal-tracking',attention:activeAcademicPeriod.renewalsOpen&&pendingRenewals>0},
    ...(unassigned===null?[]:[{label:'Résidents sans chambre',note:'Dossiers actifs à affecter',value:unassigned,action:'students',attention:unassigned>0}]),
    {label:'Hors service',note:'Exclues de la capacité',value:hsRooms,action:'rooms',attention:hsRooms>0}
  ];
  $('dash-room-status').innerHTML = statusItems.map(item=>{
    const state = item.alert?'status-alert':item.attention?'status-attention':'';
    const mark = item.alert||item.attention?'!':'✓';
    return `<li class="${state}"><button class="dashboard-status-row dashboard-status-link" type="button" data-nav-go="${item.action}" aria-label="${esc(item.label)} : ${item.value}, ${esc(item.note)}">
      <span class="status-mark" aria-hidden="true">${mark}</span><span class="status-copy">${esc(item.label)}<small>${esc(item.note)}</small></span>
      <span class="status-value">${item.value.toLocaleString('fr-FR')}</span></button></li>`;
  }).join('');

  /* Dernières affectations */
  const hist = Scope.history(snap).slice().sort((a,b)=>b.date.localeCompare(a.date)).slice(0,7);
  $('dash-activity').innerHTML = hist.length ? hist.map(h=>{
    const ic = h.type==='entree'?'ic-in':h.type==='sortie'?'ic-out':'ic-tr';
    const verb = h.type==='entree'?'est entré(e) à':h.type==='sortie'?'a quitté':'a été transféré(e) vers';
    return `<li><span class="ic ${ic}">${h.type==='entree'?Icons.check:h.type==='sortie'?Icons.out:Icons.swap}</span>
      <div><div class="txt">${esc(h.studentName)} <span style="color:var(--muted);font-weight:400">${verb} ${esc(h.roomLabel)}</span></div>
      <div class="sub">${fmtDateTime(h.date)} · par ${esc(h.userName)}</div></div></li>`;
  }).join('') : '<div class="empty">Aucun mouvement enregistré.</div>';

}

/* ══════════════ SECTION 10 — MODULE ÉTUDIANTS & AFFECTATIONS ══════════════ */
const StudentsView = { q:'', statut:'', academicYear:academicYearFor(nowISO()), annee:'', sexe:'', bloc:'', page:1, pageSize:50 };

async function renderStudents(){
  const snap = await snapshot();
  const rooms = Scope.rooms(snap);
  /* Filtres */
  const academicYears = [...new Set([academicYearFor(nowISO()), ...Scope.history(snap).map(h=>academicYearFor(h.date))].filter(Boolean))].sort((a,b)=>b.localeCompare(a));
  $('stu-academic-year').innerHTML = academicYears.map(year=>`<option value="${year}">${year}</option>`).join('');
  $('stu-statut').innerHTML = '<option value="">Statut : tous</option><option value="actif">Actif</option><option value="sorti">Sorti</option>';
  const years = [...new Set(snap.students.map(s=>s.anneeBac))].sort((a,b)=>b-a);
  $('stu-annee').innerHTML = '<option value="">Année Bac : toutes</option>' +
    years.map(y=>`<option>${y}</option>`).join('');
  $('stu-sexe').innerHTML = '<option value="">Sexe : tous</option><option value="fille">Filles</option><option value="garcon">Garçons</option>';
  const blocks=[...new Set(rooms.map(room=>room.bloc))].sort(compareNames);
  $('stu-bloc').innerHTML = '<option value="">Bloc : tous</option>' +
    blocks.map(bloc=>`<option value="${esc(bloc)}">${esc(bloc)}</option>`).join('') +
    (isAdmin()?'<option value="none">— Non affectés —</option>':'');
  $('stu-statut').value = StudentsView.statut; $('stu-academic-year').value = StudentsView.academicYear;
  $('stu-annee').value = StudentsView.annee; $('stu-sexe').value = StudentsView.sexe;
  $('stu-bloc').value = StudentsView.bloc;
  const activeStudents=snap.students.filter(student=>student.statut==='actif');
  const roomIds=new Set(rooms.map(room=>room.id));
  const unassignedCount=activeStudents.filter(student=>!student.chambreId||!roomIds.has(student.chambreId)).length;
  $('students-unassigned-action').innerHTML=isAdmin()&&unassignedCount
    ? `<button class="btn btn-warning" type="button" data-action="students-unassigned" aria-label="Afficher les ${unassignedCount} résidents sans chambre">Résidents sans chambre <strong>${unassignedCount}</strong></button>`
    : '';
  $('stu-searchwrap').innerHTML = Icons.search +
    `<input class="inp" id="stu-q" data-f="students.q" placeholder="Nom ou matricule…" value="${esc(StudentsView.q)}">`;
  $('stu-scopenote').innerHTML = isAdmin() ? '' :
    `<div class="scope-note">Périmètre agent : seuls les étudiants hébergés dans votre bloc (${Session.bloc()}) sont visibles.</div>`;
  await renderStudentsTable();
}
async function renderStudentsTable(){
  const snap = await snapshot();
  const f = StudentsView;
  let list = Scope.students(snap);
  if (f.academicYear){
    const studentIds = new Set(Scope.history(snap).filter(h=>academicYearFor(h.date)===f.academicYear).map(h=>h.studentId));
    if (f.academicYear===academicYearFor(nowISO())){
      snap.students.filter(student=>student.statut==='actif').forEach(student=>studentIds.add(student.id));
    }
    list = list.filter(student=>studentIds.has(student.id));
  }
  if (f.q){ const t=f.q.toLowerCase(); list = list.filter(s=>(s.nom+' '+s.prenom+' '+s.matricule).toLowerCase().includes(t)); }
  if (f.statut) list = list.filter(s=>s.statut===f.statut);
  if (f.annee) list = list.filter(s=>String(s.anneeBac)===f.annee);
  if (f.sexe) list = list.filter(s=>residentGender(s.sexe)===f.sexe);
  if (f.bloc==='none'){
    const roomIds=new Set(Scope.rooms(snap).map(room=>room.id));
    list = list.filter(student=>!student.chambreId||!roomIds.has(student.chambreId));
  }
  else if (f.bloc){
    const roomsById=new Map(Scope.rooms(snap).map(room=>[room.id,room]));
    list = list.filter(student=>roomsById.get(student.chambreId)?.bloc===f.bloc);
  }
  list.sort((a,b)=>a.nom.localeCompare(b.nom));
  $('stu-count').textContent = `${list.length} étudiant${list.length>1?'s':''} affiché${list.length>1?'s':''}`;
  $('tb-sub').textContent = `${snap.students.length} dossiers au total`;
  const pagination=paginateItems(list,f.page,f.pageSize);
  f.page=pagination.page;
  const pageCount=Math.max(1,pagination.pageCount);
  const roomOf = id => snap.rooms.find(r=>r.id===id);
  $('stu-tbody').innerHTML = pagination.total ? pagination.items.map(s=>{
    const r = roomOf(s.chambreId);
    const admin = isAdmin();
    let acts = `<button class="btn-icon hov-info" data-action="stu-open" data-id="${s.id}" title="Voir la fiche">${Icons.eye}</button>`;
    if (admin){
      acts += `<button class="btn-icon hov-warn" data-action="stu-edit" data-id="${s.id}" title="Modifier">${Icons.edit}</button>`;
      acts += s.chambreId
        ? `<button class="btn-icon hov-brand" data-action="stu-transfer" data-id="${s.id}" title="Transférer">${Icons.swap}</button>
           <button class="btn-icon hov-warn" data-action="stu-release" data-id="${s.id}" title="Libérer la chambre">${Icons.out}</button>`
        : `<button class="btn-icon hov-ok" data-action="stu-assign" data-id="${s.id}" title="Affecter à une chambre">${Icons.bed}</button>`;
      acts += `<button class="btn-icon hov-bad" data-action="stu-del" data-id="${s.id}" title="Supprimer">${Icons.trash}</button>`;
    }
    return `<tr>
      <td class="name mono"><button type="button" class="student-matricule-link" data-action="stu-open" data-id="${esc(s.id)}" aria-label="Afficher la fiche résident de ${esc(s.matricule)}">${esc(s.matricule)}</button><span>${esc(s.anneeBac)}</span></td>
      <td class="name"><b class="${studentGenderClass(s.sexe)}">${esc(s.nom)} ${esc(s.prenom)}</b><span>${esc([s.commune,s.wilaya].filter(Boolean).join(', '))}</span></td>
      <td class="name"><b style="font-weight:600">${esc(s.filiere||'—')}</b><span>${esc(s.niveau)}</span></td>
      <td>${r?`<span class="badge b-info">${roomLabel(r)}</span>`:'<span class="badge b-neutral">Non affecté</span>'}</td>
      <td>${s.statut==='actif'?b(['b-dot b-ok','Actif']):b(['b-dot b-neutral','Sorti'])}</td>
      <td class="actions">${acts}</td></tr>`;
  }).join('') : `<tr><td colspan="6"><div class="empty">Aucun étudiant ne correspond aux critères.</div></td></tr>`;
  $('students-pagination').innerHTML=`<div class="table-pagination">
    <span>${pagination.total?`Affichage ${pagination.start+1}–${pagination.end} sur ${pagination.total} résidents`:'Aucun résultat'}</span>
    <div class="table-pagination-controls">
      <label class="table-pagination-size">Par page
        <select class="inp" data-students-page-size aria-label="Nombre de résidents par page">
          ${[25,50,100].map(size=>`<option value="${size}"${size===f.pageSize?' selected':''}>${size}</option>`).join('')}
        </select>
      </label>
      <button class="btn btn-ghost btn-sm" type="button" data-action="students-page" data-page="${f.page-1}"${f.page<=1?' disabled':''}>Précédent</button>
      <span aria-live="polite">Page ${f.page} sur ${pageCount}</span>
      <button class="btn btn-ghost btn-sm" type="button" data-action="students-page" data-page="${f.page+1}"${f.page>=pageCount?' disabled':''}>Suivant</button>
    </div>
  </div>`;
}

/* — Formulaire étudiant (création / modification) — */
async function openStudentForm(student){
  const snap=await snapshot();
  const s = student ? {...student,...(await Store.get('students',student.id)||{})} : {};
  const currentRoom=snap.rooms.find(room=>room.id===s.chambreId);
  const blockNames=[...new Set([...(snap.blocks||[]).map(block=>block.name),...snap.rooms.map(room=>room.bloc)].filter(Boolean))].sort(compareNames);
  const initialBlock=currentRoom?.bloc||'';
  const roomOptions=(bloc,selectedId='',sexe=s.sexe)=>{
    const rooms=snap.rooms
      .filter(room => room.bloc===bloc && (room.id===selectedId || (room.statut!=='hors_service' && occupantIds(snap,room.id).filter(resident=>resident.id!==s.id).length < room.capacite)))
      .sort((a,b)=>compareNames(a.numero,b.numero));
    if(!rooms.length) return '<option value="">Aucune chambre disponible dans ce bloc</option>';
    return '<option value="">Choisir une chambre</option>'+rooms.map(room=>{
      const occupied=occupantIds(snap,room.id).filter(resident=>resident.id!==s.id).length;
      const residenceIncompatible=!isResidenceGenderCompatible({sexe});
      const incompatible=!isBlockGenderCompatible(snap,{sexe},room);
      const unavailable=room.statut==='hors_service'||occupied>=room.capacite||incompatible;
      const roomNumber=String(room.numero).padStart(3,'0');
      const label=`${roomLabel(room)} · ${floorLabel(floorNumber(room.numero))} · chambre ${roomNumber.slice(-2)} · ${occupied}/${room.capacite}`;
      return `<option value="${esc(room.id)}" ${room.id===selectedId?'selected':''} ${unavailable&&room.id!==s.chambreId?'disabled':''}>${esc(label)}${room.statut==='hors_service'?' · hors service':incompatible?residenceIncompatible?' · sexe non admis dans cette résidence':' · réservé aux '+blockGenderLabel(blockGender(snap,room.bloc)).toLowerCase():occupied>=room.capacite&&room.id!==s.chambreId?' · complète':''}</option>`;
    }).join('');
  };
  const currentYear=new Date().getFullYear();
  const years=[...new Set([
    ...Array.from({length:11},(_,offset)=>currentYear-offset),
    ...(Number.isInteger(s.anneeBac)?[s.anneeBac]:[])
  ])].sort((a,b)=>b-a);
  const f = v => esc(v ?? '');
  Modal.open({
    title: s.id ? 'Modifier l\u2019étudiant' : 'Nouveau résident',
    sub: s.id ? `${s.nom} ${s.prenom} · matricule ${s.matricule}` : 'Fiche administrative du résident',
    wide: true,
    body: `<div class="fgrid">
      <div class="triple">
        <div class="field"><label>Année du Bac <span class="req">*</span></label><select class="inp" name="anneeBac" required>${years.map(y=>`<option ${s.anneeBac===y?'selected':''}>${y}</option>`).join('')}</select></div>
        <div class="field"><label>Matricule (n° Bac) <span class="req">*</span></label><input class="inp" name="matricule" required value="${f(s.matricule)}" placeholder="ex. 31012345"></div>
        <div class="field"><label>Numéro d’inscription</label><input class="inp" name="numeroInscription" readonly value="${f(s.numeroInscription || (s.matricule ? `${s.anneeBac || years[0]}${s.matricule}` : ''))}"></div>
      </div>
      <div class="field"><label>Nom <span class="req">*</span></label><input class="inp" name="nom" required value="${f(s.nom)}"></div>
      <div class="field"><label>Prénom <span class="req">*</span></label><input class="inp" name="prenom" required value="${f(s.prenom)}"></div>
      <input type="hidden" name="nomComplet" value="${f(s.nomComplet || [s.nom,s.prenom].filter(Boolean).join(' '))}">
      <div class="field"><label>Date de naissance</label><input class="inp" type="text" name="dateNaissance" value="${f(dateInputValue(s.dateNaissance))}" placeholder="dd/mm/yyyy" inputmode="numeric"></div>
      <div class="field"><label>Lieu de naissance</label><input class="inp" name="lieuNaissance" value="${f(s.lieuNaissance)}"></div>
      <div class="field"><label>Sexe</label><select class="inp" name="sexe"><option value="">—</option><option value="Fille" ${s.sexe==='Fille'?'selected':''}>Fille</option><option value="Garcon" ${s.sexe==='Garcon'?'selected':''}>Garçon</option></select></div>
      <div class="field"><label>Nationalité</label><input class="inp" name="nationalite" value="${f(s.nationalite)}"></div>
      <div class="field"><label>Téléphone</label><input class="inp" name="telephone" value="${f(s.telephone)}" placeholder="05…"></div>
      <div class="field"><label>Email</label><input class="inp" type="email" name="email" value="${f(s.email)}"></div>
      <div class="field full"><label>Photo / avatar</label><div class="student-photo-control ${studentGenderClass(s.sexe)}"><div class="student-photo-preview-column"><div class="student-photo-preview" data-student-avatar-preview>${studentAvatarMarkup(s)}</div><div class="student-photo-help"><button class="student-photo-remove" type="button" data-student-avatar-clear ${s.avatar?'':'hidden'}>Retirer la photo</button></div></div><label class="student-photo-drop" data-student-photo-drop><input class="student-photo-file" type="file" accept="image/*" data-student-avatar-file aria-label="Choisir une photo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4m0 0-4 4m4-4 4 4"/><path d="M5 14v5h14v-5"/></svg><strong>Déposez une photo ici</strong><span>ou</span><span>Cliquez pour parcourir vos fichiers</span><span class="student-photo-file-meta" data-student-avatar-filename>Nommez chaque photo avec le numéro d’inscription (Année du Bac + Matricule). Elle sera enregistrée dans le dossier choisi dans Paramètres > Général.</span></label><input type="hidden" name="avatar" value="${f(s.avatar)}"></div></div>
      <div class="sec-title full">Adresse</div>
      <div class="field full"><label>Rue</label><input class="inp" name="rue" value="${f(s.rue)}"></div>
      <div class="field"><label>Commune</label><input class="inp" name="commune" value="${f(s.commune)}"></div>
      <div class="field"><label>Wilaya</label><input class="inp" name="wilaya" value="${f(s.wilaya)}"></div>
      <div class="sec-title full">Scolarité</div>
      <div class="field"><label>Filière</label><input class="inp" name="filiere" value="${f(s.filiere)}"></div>
      <div class="field"><label>Niveau d\u2019étude</label><select class="inp" name="niveau">${NIVEAUX.map(n=>`<option ${s.niveau===n?'selected':''}>${n}</option>`).join('')}</select></div>
      <div class="field full"><label>Faculté / Institut</label><input class="inp" name="faculte" value="${f(s.faculte)}"></div>
      <div class="sec-title full">Affecter à une chambre</div>
      <div class="triple">
        <div class="field"><label>Bloc</label><select class="inp" name="assignmentBloc"><option value="" ${initialBlock?'disabled':''}>Choisir un bloc</option>${blockNames.map(bloc=>`<option value="${esc(bloc)}" ${bloc===initialBlock?'selected':''}>${esc(bloc)}</option>`).join('')}</select></div>
        <div class="field"><label>Chambre</label><select class="inp" name="assignmentRoom" ${initialBlock?'':'disabled'}>${roomOptions(initialBlock,s.chambreId||'')}</select></div>
        <div class="field"><label>Chambre complète</label><output class="inp" data-assignment-preview style="display:flex;align-items:center;min-height:38px;color:var(--brand);font-weight:700">${currentRoom?esc(roomLabel(currentRoom)):'—'}</output></div>
      </div>
    </div>`,
    footer:`<button class="btn btn-ghost" data-mclose>Annuler</button><button class="btn btn-primary" data-save>${s.id?'Enregistrer':'Créer la fiche'}</button>`,
    onMount(ov){
      const form = ov.querySelector('form');
      const avatarInput=ov.querySelector('[data-student-avatar-file]'), avatarValue=form.elements.avatar;
      const avatarPreview=ov.querySelector('[data-student-avatar-preview]'), clearAvatar=ov.querySelector('[data-student-avatar-clear]');
      const photoControl=ov.querySelector('.student-photo-control');
      const photoDrop=ov.querySelector('[data-student-photo-drop]'), avatarFilename=ov.querySelector('[data-student-avatar-filename]');
      const genderSelect=form.elements.sexe;
      let avatarRequest=0;
      let selectedAvatarData='';
      const refreshAvatarPreview=()=>{
        avatarPreview.innerHTML=studentAvatarMarkup({...s,avatar:avatarValue.value,sexe:genderSelect.value,numeroInscription:form.elements.numeroInscription.value});
        clearAvatar.hidden=!avatarValue.value;
        if(!selectedAvatarData) safe(()=>hydrateStudentFolderAvatars(avatarPreview));
      };
      safe(()=>hydrateStudentFolderAvatars(avatarPreview));
      const processAvatarFile=async file=>{
        if(!file) return;
        const request=++avatarRequest;
        try{ const value=await studentAvatarData(file); if(request!==avatarRequest) return; selectedAvatarData=value; avatarValue.value=value; avatarFilename.textContent=`Photo prête : ${form.elements.numeroInscription.value||'Année du Bac + Matricule'}.webp`; refreshAvatarPreview(); }
        catch(error){ if(request===avatarRequest) toast(error.message||'Impossible de lire cette image.','error'); }
      };
      avatarInput.addEventListener('change',()=>processAvatarFile(avatarInput.files?.[0]));
      photoDrop.addEventListener('dragenter',event=>{ event.preventDefault(); photoDrop.classList.add('is-dragging'); });
      photoDrop.addEventListener('dragover',event=>{ event.preventDefault(); if(event.dataTransfer) event.dataTransfer.dropEffect='copy'; photoDrop.classList.add('is-dragging'); });
      photoDrop.addEventListener('dragleave',event=>{ if(!photoDrop.contains(event.relatedTarget)) photoDrop.classList.remove('is-dragging'); });
      photoDrop.addEventListener('drop',event=>{ event.preventDefault(); photoDrop.classList.remove('is-dragging'); processAvatarFile(event.dataTransfer?.files?.[0]); });
      clearAvatar.addEventListener('click',()=>{ avatarRequest++; selectedAvatarData=''; avatarValue.value=''; avatarInput.value=''; avatarFilename.textContent='Nommez chaque photo avec le numéro d’inscription (Année du Bac + Matricule). Elle sera enregistrée dans le dossier choisi dans Paramètres > Général.'; refreshAvatarPreview(); });
      genderSelect.addEventListener('change',()=>{ photoControl.className=`student-photo-control ${studentGenderClass(genderSelect.value)}`; if(!avatarValue.value) refreshAvatarPreview(); roomSelect.innerHTML=roomOptions(blockSelect.value,roomSelect.value,genderSelect.value); });
      const blockSelect=form.elements.assignmentBloc, roomSelect=form.elements.assignmentRoom, roomPreview=ov.querySelector('[data-assignment-preview]');
      const updateRoomPreview=()=>{ const room=snap.rooms.find(item=>item.id===roomSelect.value); roomPreview.textContent=room?roomLabel(room):'—'; };
      blockSelect.addEventListener('change',()=>{
        roomSelect.innerHTML=roomOptions(blockSelect.value);
        roomSelect.disabled=!blockSelect.value;
        updateRoomPreview();
      });
      roomSelect.addEventListener('change',updateRoomPreview);
      const updateNumeroInscription = () => {
        const matricule = form.elements.matricule.value.trim();
        form.elements.numeroInscription.value = matricule ? `${form.elements.anneeBac.value}${matricule}` : '';
        if(selectedAvatarData) avatarFilename.textContent=`Photo prête : ${form.elements.numeroInscription.value}.webp`;
        if(!avatarValue.value) refreshAvatarPreview();
      };
      const updateNomComplet = () => {
        form.elements.nomComplet.value = [form.elements.nom.value,form.elements.prenom.value].map(value=>value.trim()).filter(Boolean).join(' ');
      };
      form.elements.anneeBac.addEventListener('change', updateNumeroInscription);
      form.elements.matricule.addEventListener('input', updateNumeroInscription);
      form.elements.nom.addEventListener('input', updateNomComplet);
      form.elements.prenom.addEventListener('input', updateNomComplet);
      updateNumeroInscription();
      updateNomComplet();
      ov.querySelector('[data-save]').addEventListener('click', async e => {
        e.preventDefault();
        await safe(async () => {
          updateNomComplet();
          const fd = new FormData(form);
          const data = Object.fromEntries(fd.entries());
          if(!s.id||s.statut==='actif') assertResidenceGenderCompatible({...s,...data});
          const assignmentRoom=String(data.assignmentRoom||'');
          const selectedBlock=String(data.assignmentBloc||'');
          delete data.assignmentBloc;
          delete data.assignmentRoom;
          if(selectedBlock!==initialBlock&&!assignmentRoom) throw AppError('Choisissez une chambre dans le bloc sélectionné.');
          const selectedRoomId=assignmentRoom||s.chambreId||null;
          if(selectedBlock&&!selectedRoomId) throw AppError('Choisissez une chambre dans le bloc sélectionné ou effacez le bloc.');
          if(selectedRoomId&&selectedRoomId!==s.chambreId){
            const targetRoom=snap.rooms.find(room=>room.id===selectedRoomId);
            if(!targetRoom||targetRoom.bloc!==selectedBlock) throw AppError('La chambre choisie ne correspond pas au bloc sélectionné.');
            assertBlockGenderCompatible(snap,{...s,sexe:data.sexe},targetRoom);
            const occupied=occupantIds(snap,targetRoom.id).filter(resident=>resident.id!==s.id).length;
            if(targetRoom.statut==='hors_service'||occupied>=targetRoom.capacite) throw AppError('Cette chambre n’a plus de place disponible.');
          }
          if(selectedRoomId&&selectedRoomId===s.chambreId&&s.statut!=='sorti'){
            const targetRoom=snap.rooms.find(room=>room.id===selectedRoomId);
            if(targetRoom) assertBlockGenderCompatible(snap,{...s,sexe:data.sexe},targetRoom);
          }
          const dateNaissance = parseDisplayDate(data.dateNaissance);
          if (dateNaissance === null) throw AppError('Date invalide. Utilisez le format dd/mm/yyyy.');
          data.dateNaissance = dateNaissance;
          if (!data.matricule.trim() || !data.nom.trim() || !data.prenom.trim())
            throw AppError('Merci de renseigner les champs obligatoires (*).');
          data.anneeBac = +data.anneeBac;
          if(selectedAvatarData){
            const photos=window.hebergia?.photos;
            if(!photos) throw AppError('L’enregistrement des photos nécessite l’application de bureau.');
            await photos.saveStudentAvatar(data.numeroInscription,selectedAvatarData);
            data.avatar='';
          }
          data.matricule = data.matricule.trim();
          if (s.id){
            await Store.update('students', s.id, data);
            if(selectedRoomId&&selectedRoomId!==s.chambreId) await Services.assign(s.id,selectedRoomId,'Affectation depuis la fiche étudiant');
            toast('Fiche étudiant mise à jour.','success');
          } else {
            const created={id:uid(),statut:'actif',chambreId:null,...data};
            await Store.insert('students',created);
            if(selectedRoomId) await Services.assign(created.id,selectedRoomId,'Affectation initiale depuis la fiche étudiant');
            toast('Étudiant créé.','success');
          }
          Modal.close(); await refresh();
        });
      });
    }
  });
}

/* — Fiche étudiant (détail + parcours) — */
async function openStudentFiche(id){
  currentStudentFicheId=id;
  showView('student-detail');
}
const HOUSING_DOSSIER_STATUSES=[
  ['a_renouveler','À renouveler'],
  ['en_preparation','En préparation'],
  ['incomplet','Incomplet'],
  ['soumis','Soumis'],
  ['accepte','Accepté'],
  ['refuse','Refusé'],
  ['clos','Clos (résident sorti)']
];
const ACADEMIC_DECISIONS=[
  ['en_attente','En attente'],
  ['admis','Admis'],
  ['redouble','Redouble']
];
function academicYearStart(year){const match=String(year||'').match(/^(\d{4})\/(\d{4})$/);return match&&Number(match[2])===Number(match[1])+1?Number(match[1]):null;}
function dossierStatusLabel(status){return HOUSING_DOSSIER_STATUSES.find(([key])=>key===status)?.[1]||'À renouveler';}
function renewalDossierDisplayLabel(dossier,campaignStatus){
  const status=renewalDossierDisplayStatus(dossier,campaignStatus);
  if(status==='clos_sans_decision') return 'Clôturé sans décision';
  if(status==='non_ouverte') return 'Campagne non ouverte';
  return dossierStatusLabel(status);
}
function renewalAssignmentDisplayStatus(student,dossier,snap){
  const hasCurrentRoom=student?.statut==='actif'&&snap.rooms.some(room=>room.id===student.chambreId);
  const pendingMove=dossier?.assignmentStatus==='a_confirmer'
    &&dossier.targetRoomId&&dossier.targetRoomId!==student?.chambreId;
  if(hasCurrentRoom&&!pendingMove) return 'confirmee';
  return dossier?.assignmentStatus||'a_decider';
}
function renewalAssignmentDisplayLabel(student,dossier,snap){
  const status=renewalAssignmentDisplayStatus(student,dossier,snap);
  if(status==='confirmee') return dossier?.assignmentStatus==='confirmee'
    ?dossier.assignmentAction==='reconduite'?'Reconduite':'Confirmée'
    :'Confirmée (résident déjà installé)';
  if(status==='en_attente') return 'En attente';
  return 'À confirmer';
}
const RENEWAL_CAMPAIGN_STATUSES=[
  ['brouillon','Brouillon'],
  ['ouverte','Ouverte'],
  ['suspendue','Suspendue'],
  ['cloturee','Clôturée']
];
const renewalCampaignStatusLabel=status=>RENEWAL_CAMPAIGN_STATUSES.find(([key])=>key===status)?.[1]||'Brouillon';
async function ensureStudentAnnualRecords(student,year=currentAcademicYear()){
  const [academicRecords,housingDossiers]=await Promise.all([Store.list('academicRecords'),Store.list('housingDossiers')]);
  let academic=academicRecords.find(row=>row.studentId===student.id&&row.academicYear===year);
  let dossier=housingDossiers.find(row=>row.studentId===student.id&&row.academicYear===year);
  const years=academicRecords.filter(row=>row.studentId===student.id&&academicYearStart(row.academicYear)!==null&&academicYearStart(row.academicYear)<academicYearStart(year)).sort((a,b)=>academicYearStart(b.academicYear)-academicYearStart(a.academicYear));
  const previous=years[0]||null;
  if(!academic){
    const promoted=previous?.decision==='admis';
    academic={id:`academic-${student.id}-${year}`,studentId:student.id,academicYear:year,filiere:previous?.filiere||student.filiere||'',faculte:previous?.faculte||student.faculte||'',niveau:promoted?nextAcademicLevel(previous.niveau):previous?.niveau||student.niveau||'',decision:'en_attente',updatedAt:nowISO()};
    await Store.insert('academicRecords',academic);
  }
  if(!dossier){
    dossier={id:`housing-${student.id}-${year}`,studentId:student.id,academicYear:year,status:student.statut==='actif'?'a_renouveler':'clos',notes:'',submittedAt:null,decisionAt:null,updatedAt:nowISO()};
    await Store.insert('housingDossiers',dossier);
  }
  return {academic,dossier,previous};
}
function printResidentDocument(content,templateSettings=null){
  const previous=$('resident-print-root');
  if(previous) previous.remove();
  const root=document.createElement('main');
  root.id='resident-print-root';
  root.style.display='none';
  root.innerHTML=content;
  const style=document.createElement('style');
  style.id='resident-print-style';
  style.textContent=`
    @page{size:A4 ${templateSettings?.orientation==='landscape'?'landscape':'portrait'};margin:0}
    @media print{
      html,body{width:${templateSettings?.orientation==='landscape'?'297mm':'210mm'}!important;height:auto!important;min-height:0!important;overflow:visible!important;background:#fff!important}
      body.printing-resident-document{display:block!important;margin:0!important;padding:0!important}
      body.printing-resident-document>*:not(#resident-print-root){display:none!important}
      body.printing-resident-document #resident-print-root{display:block!important;width:${templateSettings?.orientation==='landscape'?'297mm':'210mm'}!important;margin:0!important;padding:0!important}
      .resident-document-sheet{box-sizing:border-box;width:210mm;min-height:297mm;margin:0;padding:20mm 21mm 18mm;background:#fff;color:#1b2935;font-family:Georgia,'Times New Roman',serif;font-size:11.5pt;line-height:1.65;display:flex;flex-direction:column;position:relative;print-color-adjust:exact}
      .resident-document-sheet.template-document{width:${templateSettings?.orientation==='landscape'?'297mm':'210mm'}!important;min-height:${templateSettings?.orientation==='landscape'?'210mm':'297mm'}!important;padding:${['top','right','bottom','left'].map(side=>Math.max(0,Math.min(40,Number(templateSettings?.margins?.[side])||0))+'mm').join(' ')}!important}
      .template-document-header{display:flex;align-items:center;gap:12px;padding-bottom:12px;border-bottom:1px solid #aab6c2;font:10pt Arial,sans-serif;color:#536474}.template-document-header p{margin:2px 0}
      .template-logo{max-width:32mm;max-height:22mm;object-fit:contain}
      .template-document-title{margin:18mm 0 10mm;text-align:center;font:bold 19pt Arial,sans-serif;color:#142b40;text-transform:uppercase}
      .template-document-body{flex:1}.template-document-body p{margin:0 0 6mm}
      .template-document-signature{display:flex;flex-direction:column;gap:5px;margin-top:auto;padding-top:14mm;break-inside:avoid;font:11pt Arial,sans-serif}
      .template-document-signature span{margin-top:2mm}.template-signature-image{max-width:48mm;max-height:24mm;object-fit:contain}
      .template-document-footer{margin-top:10mm;padding-top:4mm;border-top:1px solid #d7dee5;text-align:center;color:#687684;font:8pt Arial,sans-serif}
      .resident-document-header{text-align:center;padding-bottom:6mm;border-bottom:1px solid #aab6c2}
      .resident-document-header .eyebrow{margin:0 0 1.5mm;color:#536474;font-family:Arial,sans-serif;font-size:9pt;font-weight:700;letter-spacing:1.4px;text-transform:uppercase}
      .resident-document-header h1{margin:0;color:#142b40;font-family:Arial,sans-serif;font-size:17pt;line-height:1.3}
      .resident-document-header .department{margin:2mm 0 0;color:#536474;font-family:Arial,sans-serif;font-size:9.5pt}
      .resident-document-date{text-align:right;margin:5mm 0 6mm;font-family:Arial,sans-serif;font-size:10pt}
      .resident-document-title{margin:0 0 8mm;text-align:center;color:#142b40;font-family:Arial,sans-serif;font-size:19pt;font-weight:700;text-transform:uppercase}
      .resident-document-lead{margin:0 0 5mm}
      .resident-document-facts{display:grid;grid-template-columns:1fr 1fr;gap:3mm 12mm;margin:2mm 0 6mm;padding:5mm 7mm;border:1px solid #d7dee5}
      .resident-document-fact span{display:block;color:#627181;font-family:Arial,sans-serif;font-size:8.5pt;font-weight:700;text-transform:uppercase}
      .resident-document-fact strong{display:block;margin-top:1mm;color:#172b3b;font-size:11pt}
      .resident-document-copy{margin:0 0 6mm;text-align:justify}
      .resident-document-signature{display:flex;justify-content:space-between;gap:12mm;margin-top:auto;padding-top:10mm;break-inside:avoid}
      .resident-document-signature p{margin:0}
      .resident-document-signature-block{width:65mm;min-height:28mm;text-align:center}
      .resident-document-signature-block strong,.resident-document-signature-block span{display:block}
      .resident-document-signature-block span{margin-top:16mm;color:#627181;font-family:Arial,sans-serif;font-size:9pt}
      .resident-document-footer{margin-top:8mm;padding-top:3mm;border-top:1px solid #d7dee5;color:#687684;font-family:Arial,sans-serif;font-size:8pt;text-align:center}
    }
  `;
  document.head.appendChild(style);
  document.body.appendChild(root);
  document.body.classList.add('printing-resident-document');
  const cleanup=()=>{
    document.body.classList.remove('printing-resident-document');
    root.remove();
    style.remove();
  };
  window.addEventListener('afterprint',cleanup,{once:true});
  requestAnimationFrame(()=>{
    try{ window.focus(); window.print(); }
    catch(error){ cleanup(); toast(error.message||'Impossible d’ouvrir la boîte d’impression.','error'); }
  });
}
function residentDocumentShell(establishment,content){
  return `<article class="resident-document-sheet"><header class="resident-document-header"><p class="eyebrow">Résidence universitaire</p><h1>${esc(establishment)}</h1><p class="department">Service de l’administration</p></header>${content}</article>`;
}
async function printStudentCertificate(student,room){
  if(!room||student.statut!=='actif') return toast('L’attestation est réservée aux résidents actifs affectés à une chambre.','warning');
  const template=await ensureDefaultDocumentTemplate('attestation');
  const templates=(await Store.list('documentTemplates')).filter(row=>row.type==='attestation');
  Modal.open({title:'Préparer une attestation',sub:`${student.prenom||''} ${student.nom||''} · matricule ${student.matricule}`,
    body:`<div class="field"><label>Modèle</label><select class="inp" name="documentTemplate">${templates.map(row=>`<option value="${esc(row.id)}" ${row.id===template.id?'selected':''}>${esc(row.name)}${row.isDefault?' — par défaut':''}</option>`).join('')}</select></div>`,
    footer:'<button class="btn btn-ghost" data-mclose>Annuler</button><button class="btn btn-primary" type="button" data-print-template>Imprimer / PDF</button>',
    onMount:overlay=>overlay.querySelector('[data-print-template]').addEventListener('click',()=>safe(()=>printSelectedDocumentTemplate(overlay.querySelector('[name="documentTemplate"]').value,'attestation',student,room)))});
}
async function printSelectedDocumentTemplate(templateId,type,student,room,extra={}){
  const template=await Store.get('documentTemplates',templateId);
  if(!template||template.type!==type) throw AppError('Le modèle sélectionné est introuvable.');
  const settings=parseDocumentTemplate(template);
  const content=templatePageMarkup(template,{student,room,...extra});
  Modal.close(true);
  printResidentDocument(content,settings);
}
async function openCustomResidentDocument(student,room){
  const customTypes=await Store.list('documentTypes');
  if(!customTypes.length) return;
  const options=await Promise.all(customTypes.map(async customType=>{
    const type=`custom:${customType.id}`;
    const defaultTemplate=await ensureDefaultDocumentTemplate(type,customType.name);
    const templates=(await Store.list('documentTemplates')).filter(template=>template.type===type);
    return {customType,type,defaultTemplate,templates};
  }));
  Modal.open({title:'Autre document',sub:`${student.prenom||''} ${student.nom||''} · matricule ${student.matricule}`,
    body:`<div class="fgrid"><div class="field"><label>Type de document</label><select class="inp" name="customDocumentType">${options.map(option=>`<option value="${esc(option.type)}">${esc(option.customType.name)}</option>`).join('')}</select></div><div class="field"><label>Modèle</label><select class="inp" name="customDocumentTemplate"></select></div><div class="field"><label>Date personnalisée (facultatif)</label><input class="inp" type="date" name="customDocumentDate"></div><div class="field"><label>Heure (facultatif)</label><input class="inp" type="time" name="customDocumentTime"></div><div class="field"><label>Lieu (facultatif)</label><input class="inp" name="customDocumentLocation" maxlength="160"></div><div class="field"><label>Objet (facultatif)</label><input class="inp" name="customDocumentSubject" maxlength="160"></div></div>`,
    footer:'<button class="btn btn-ghost" data-mclose>Annuler</button><button class="btn btn-primary" type="button" data-print-custom-document>Imprimer / PDF</button>',
    onMount:overlay=>{
      const typeSelect=overlay.querySelector('[name="customDocumentType"]');
      const templateSelect=overlay.querySelector('[name="customDocumentTemplate"]');
      const updateTemplates=()=>{
        const selected=options.find(option=>option.type===typeSelect.value);
        templateSelect.innerHTML=selected.templates.map(template=>`<option value="${esc(template.id)}" ${template.id===selected.defaultTemplate.id?'selected':''}>${esc(template.name)}${template.isDefault?' — par défaut':''}</option>`).join('');
      };
      typeSelect.addEventListener('change',updateTemplates);
      updateTemplates();
      overlay.querySelector('[data-print-custom-document]').addEventListener('click',()=>safe(async()=>{
        const date=overlay.querySelector('[name="customDocumentDate"]').value;
        await printSelectedDocumentTemplate(templateSelect.value,typeSelect.value,student,room,{
          dateConvocation:date?fmtDate(date):'',heure:overlay.querySelector('[name="customDocumentTime"]').value,
          lieu:overlay.querySelector('[name="customDocumentLocation"]').value.trim(),
          objet:overlay.querySelector('[name="customDocumentSubject"]').value.trim()
        });
      }));
    }});
}
async function openStudentConvocation(student,room){
  const establishment=localStorage.getItem('hebergia_establishment')?.trim()||'Résidence universitaire Pepiniere';
  const name=`${student.prenom||''} ${student.nom||''}`.trim();
  const defaultTemplate=await ensureDefaultDocumentTemplate('convocation');
  const templates=(await Store.list('documentTemplates')).filter(row=>row.type==='convocation');
  Modal.open({
    title:'Préparer une convocation',
    sub:`${name} · matricule ${student.matricule}`,
    body:`<div class="fgrid">
      <div class="field"><label>Date du rendez-vous <span class="req">*</span></label><input class="inp" type="date" name="appointmentDate" min="${nowISO().slice(0,10)}" required></div>
      <div class="field"><label>Heure <span class="req">*</span></label><input class="inp" type="time" name="appointmentTime" required></div>
      <div class="field full"><label>Objet <span class="req">*</span></label><input class="inp" name="appointmentSubject" value="Mise à jour du dossier d’hébergement" maxlength="160" required></div>
      <div class="field full"><label>Lieu</label><input class="inp" name="appointmentLocation" value="Bureau de l’administration de la résidence" maxlength="160"></div>
      <div class="field full"><label>Modèle de document</label><select class="inp" name="documentTemplate">${templates.map(row=>`<option value="${esc(row.id)}" ${row.id===defaultTemplate.id?'selected':''}>${esc(row.name)}${row.isDefault?' — par défaut':''}</option>`).join('')}</select></div>
    </div>`,
    footer:`<button class="btn btn-ghost" data-mclose>Annuler</button><button class="btn btn-primary" type="button" data-print-convocation>Imprimer / PDF</button>`,
    onMount(overlay){
      overlay.querySelector('[data-print-convocation]').addEventListener('click',event=>{
        event.preventDefault();
        const form=overlay.querySelector('form');
        const appointmentDate=form.elements.appointmentDate.value;
        const appointmentTime=form.elements.appointmentTime.value;
        const subject=String(form.elements.appointmentSubject.value||'').trim();
        const location=String(form.elements.appointmentLocation.value||'').trim();
        if(!appointmentDate||!appointmentTime||!subject) return toast('Renseignez la date, l’heure et l’objet du rendez-vous.','warning');
        safe(()=>printSelectedDocumentTemplate(form.elements.documentTemplate.value,'convocation',student,room,{
          dateConvocation:fmtDate(appointmentDate),heure:appointmentTime,lieu:location||establishment,objet:subject
        }));
      });
    }
  });
}
async function renderStudentFichePage(root=$('student-fiche-root'),{embedded=false,onBack=null}={}){
  if(!root||!currentStudentFicheId) return;
  let snap = await snapshot();
  let s = snap.students.find(x=>x.id===currentStudentFicheId);
  if (!s){ toast('Étudiant introuvable.','error'); return showView('students'); }
  const academicYear=currentAcademicYear();
  if(!snap.academicRecords?.some(row=>row.studentId===s.id&&row.academicYear===academicYear)||!snap.housingDossiers?.some(row=>row.studentId===s.id&&row.academicYear===academicYear)){
    await ensureStudentAnnualRecords(s,academicYear);
    snap=await loadSnapshot();
    s=snap.students.find(x=>x.id===currentStudentFicheId);
  }
  s={...s,...(await Store.get('students',s.id)||{})};
  const room = snap.rooms.find(r=>r.id===s.chambreId);
  const currentAcademicRecord=snap.academicRecords.find(row=>row.studentId===s.id&&row.academicYear===academicYear);
  const currentHousingDossier=snap.housingDossiers.find(row=>row.studentId===s.id&&row.academicYear===academicYear);
  const academicHistory=snap.academicRecords.filter(row=>row.studentId===s.id).sort((a,b)=>(academicYearStart(b.academicYear)||0)-(academicYearStart(a.academicYear)||0));
  const customDocumentTypes=snap.documentTypes||[];
  const parcours = snap.history.filter(h=>h.studentId===s.id).sort((a,b)=>b.date.localeCompare(a.date));
  const parcoursByYear=new Map();
  parcours.forEach(movement=>{
    const year=academicYearFor(movement.date)||'Hors année universitaire';
    if(!parcoursByYear.has(year)) parcoursByYear.set(year,[]);
    parcoursByYear.get(year).push(movement);
  });
  const parcoursGroups=[...parcoursByYear].sort(([a],[b])=>{
    if(a==='Hors année universitaire') return 1;
    if(b==='Hors année universitaire') return -1;
    return Number(b.split('/')[0])-Number(a.split('/')[0]);
  });
  const genderValue=String(s.sexe||'').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const genderClass=studentGenderClass(s.sexe);
  const genderLabel=genderValue==='garcon'?'Garçon':genderValue==='fille'?'Fille':esc(s.sexe)||'Non renseigné';
  const D = (t,v)=>`<div><dt>${t}</dt><dd>${v}</dd></div>`;
  const actions=Session.user?`<button class="btn btn-ghost" data-action="stu-edit" data-id="${esc(s.id)}">${Icons.edit} Modifier</button>
    ${s.statut==='actif'&&activeAcademicPeriod.renewalsOpen?`<button class="btn btn-ghost" data-action="stu-renewal" data-id="${esc(s.id)}">${Icons.edit} Parcours académique</button><button class="btn btn-primary" data-action="renewal-dossier" data-id="${esc(s.id)}">${Icons.clock} Dossier de renouvellement</button>`:''}
    ${room?`<button class="btn btn-ghost" data-action="stu-transfer" data-id="${esc(s.id)}">${Icons.swap} Transférer</button>
      <button class="btn btn-ghost" data-action="stu-release" data-id="${esc(s.id)}">${Icons.out} Libérer</button>`
      :`<button class="btn btn-primary" data-action="stu-assign" data-id="${esc(s.id)}">${Icons.bed} Affecter</button>`}`:'';
  $('tb-sub').textContent=`${s.nom} ${s.prenom} · matricule ${s.matricule}`;
  root.innerHTML=`<div class="toolbar"><button class="btn btn-ghost" ${embedded?'data-student-fiche-back':'data-nav="students"'}><span aria-hidden="true">←</span> ${embedded?'Retour à la fiche chambre':'Retour aux résidents'}</button>
      <span class="spacer"></span><div class="student-fiche-actions">${actions}</div></div>
    <div class="card student-fiche-page ${genderClass}"><div class="card-b">
      <div class="student-fiche-hero">
        ${studentAvatarMarkup(s,true)}
        <div class="student-fiche-identity"><div class="student-fiche-kicker">Profil résident</div><div class="student-fiche-name">${esc(s.prenom)} ${esc(s.nom)}</div>
          <div class="student-fiche-meta">Bac ${s.anneeBac} · ${esc(currentAcademicRecord.niveau)}${currentAcademicRecord.filiere?` · ${esc(currentAcademicRecord.filiere)}`:''} · ${esc(currentAcademicRecord.faculte)}</div></div>
        <div class="student-fiche-status">
          ${room?`<div class="student-fiche-room"><div class="student-fiche-room-label">Chambre</div><div class="student-fiche-room-title">${roomLabel(room)}</div></div>`:''}
          <div class="student-fiche-status-badges">${s.statut==='actif'?b(['b-dot b-ok','Actif']):b(['b-dot b-neutral','Sorti'])}
            <span class="student-gender-badge">${genderLabel}</span></div>
        </div>
      </div>
      <div class="student-fiche-content">
      <div class="sec-title student-fiche-section-title">Informations personnelles</div>
      <div class="student-info-groups">
      <section class="student-info-group"><h3>Identité</h3><dl class="dl">
        ${D('Sexe', esc(s.sexe)||'—')}
        ${D('Date de naissance', fmtDate(s.dateNaissance))}
        ${D('Lieu de naissance', esc(s.lieuNaissance)||'—')}
      </dl></section>
      <section class="student-info-group"><h3>Contact</h3><dl class="dl">
        ${D('Email', esc(s.email)||'—')}
        ${D('Téléphone', `<span class="mono">${esc(s.telephone)||'—'}</span>`)}
      </dl></section>
      <section class="student-info-group"><h3>Résidence & adresse</h3><dl class="dl">
        ${D('Adresse', esc(s.rue)||'—')}
        ${D('Commune', esc(s.commune)||'—')}
        ${D('Wilaya', esc(s.wilaya)||'—')}
      </dl></section>
      </div>
      <div class="sec-title student-fiche-section-title">Parcours dans la résidence</div>
      <div class="student-current-stay"><span class="student-current-stay-icon">${Icons.bed}</span><div class="student-current-stay-copy"><strong>${room?'Affectation actuelle':'Situation actuelle'}</strong><span>${room?`${esc(room.bloc)} · Chambre ${esc(room.numero)}`:s.statut==='actif'?'Aucune chambre affectée actuellement.':'Le résident a quitté la résidence.'}</span></div><span class="student-current-stay-status">${room?(residentGender(s.sexe)==='fille'?'Résidente installée':'Résident installé'):s.statut==='actif'?'Non affecté':'Sorti'}</span></div>
      ${parcours.length?parcoursGroups.map(([year,movements])=>`<section class="student-history-year"><h3 class="student-history-year-title">${esc(year)}</h3><ul class="tl">${movements.map(h=>{
        const ic=h.type==='entree'?'ic-in':h.type==='sortie'?'ic-out':'ic-tr';
        return `<li><div class="when"><b>${fmtDate(h.date)}</b>${fmtTime(h.date)}</div>
          <span class="ic ${ic}">${h.type==='entree'?Icons.check:h.type==='sortie'?Icons.out:Icons.swap}</span>
          <div class="what">${b(BLOC_BADGE[h.type])} ${esc(h.roomLabel)}${h.fromRoomLabel?` <span style="color:var(--muted)">(venant de ${esc(h.fromRoomLabel)})</span>`:''}
          <div class="sub">${esc(h.motif)} · par ${esc(h.userName)}</div></div></li>`;
      }).join('')}</ul></section>`).join(''):'<div class="empty">Aucun mouvement antérieur enregistré.</div>'}
      <div class="sec-title student-fiche-section-title">Parcours académique</div>
      <dl class="student-academic-info">
        ${D('Année universitaire',esc(currentAcademicRecord.academicYear))}
        ${D('Filière',esc(currentAcademicRecord.filiere)||'—')}
        ${D('Niveau d’étude',esc(currentAcademicRecord.niveau)||'—')}
        ${academicResultVisible(currentAcademicRecord.academicYear)?D('Résultat de l’année',esc(ACADEMIC_DECISIONS.find(([key])=>key===currentAcademicRecord.decision)?.[1]||'En attente')):''}
      </dl>
      <div class="student-renewal-actions"><span class="student-renewal-note">Dossier d’hébergement : <span class="student-renewal-status">${esc(renewalDossierDisplayLabel(currentHousingDossier,activeAcademicPeriod.campaignStatus))}</span>${activeAcademicPeriod.renewalsOpen?'':' · Période fermée'}</span>${Session.user&&s.statut==='actif'&&activeAcademicPeriod.renewalsOpen?`<button class="btn btn-ghost btn-sm" data-action="stu-renewal" data-id="${esc(s.id)}">${Icons.edit} Parcours académique</button><button class="btn btn-primary btn-sm" data-action="renewal-dossier" data-id="${esc(s.id)}">${Icons.clock} Gérer le dossier</button>`:''}</div>
      ${academicHistory.length>1?`<div class="tbl-wrap"><table class="academic-history"><thead><tr><th>Année</th><th>Filière</th><th>Faculté / Institut</th><th>Niveau</th><th>Résultat</th><th>Dossier logement</th></tr></thead><tbody>${academicHistory.map(record=>{const dossier=snap.housingDossiers.find(item=>item.studentId===s.id&&item.academicYear===record.academicYear),campaign=snap.renewalCampaigns.find(item=>item.academicYear===record.academicYear),result=academicResultVisible(record.academicYear)?ACADEMIC_DECISIONS.find(([key])=>key===record.decision)?.[1]||'En attente':'—';return `<tr><td>${esc(record.academicYear)}</td><td>${esc(record.filiere)||'—'}</td><td>${esc(record.faculte)||'—'}</td><td>${esc(record.niveau)||'—'}</td><td>${esc(result)}</td><td>${esc(renewalDossierDisplayLabel(dossier,campaign?.status))}</td></tr>`;}).join('')}</tbody></table></div>`:''}
      <div class="sec-title student-fiche-section-title">Documents administratifs</div>
      <div class="student-fiche-document-actions"><div class="student-fiche-document-copy"><strong>Documents du résident</strong><span>Imprimez directement ou choisissez l’enregistrement au format PDF.</span></div><div class="student-fiche-document-buttons"><button class="btn btn-ghost" type="button" data-student-certificate>Attestation d’hébergement</button><button class="btn btn-primary" type="button" data-student-convocation>Convocation</button>${customDocumentTypes.length?'<button class="btn btn-ghost" type="button" data-student-custom-document>Autres documents</button>':''}</div></div>
      </div>
      </div></div>`;
  root.querySelector('[data-student-fiche-back]')?.addEventListener('click',onBack);
  safe(()=>hydrateStudentFolderAvatars(root));
  root.querySelector('[data-student-photo-open]')?.addEventListener('click',()=>safe(async()=>{
    const name=`${s.prenom||''} ${s.nom||''}`.trim();
    const registrationNumber=String(s.numeroInscription||(s.matricule?`${s.anneeBac||2025}${s.matricule}`:'')).trim();
    const folderPhoto=registrationNumber?await window.hebergia?.photos?.readStudentAvatar(registrationNumber):null;
    const savedPhoto=folderPhoto||String(s.avatar||'');
    const photo=savedPhoto.startsWith('data:image/')
      ? `<img class="student-photo-lightbox-image" src="${esc(savedPhoto)}" alt="Photo de ${esc(name)}">`
      : `<div class="student-photo-lightbox-placeholder">${studentAvatarMarkup(s)}</div>`;
    const photoBody=`<button type="button" class="student-photo-lightbox-close" data-mclose aria-label="Fermer la photo" title="Fermer">${Icons.x}</button>${photo}`;
    Modal.open({title:'Photo agrandie',hideHeader:true,className:'student-photo-lightbox',overlayClassName:'student-photo-lightbox-backdrop',body:photoBody});
    safe(()=>hydrateStudentFolderAvatars(document.querySelector('.student-photo-lightbox')));
  }));
  root.querySelector('[data-student-certificate]')?.addEventListener('click',()=>safe(()=>printStudentCertificate(s,room)));
  root.querySelector('[data-student-convocation]')?.addEventListener('click',()=>safe(()=>openStudentConvocation(s,room)));
  root.querySelector('[data-student-custom-document]')?.addEventListener('click',()=>safe(()=>openCustomResidentDocument(s,room)));
}

async function openStudentRenewalForm(studentId){
  if(!Session.user) throw AppError('Connectez-vous pour gérer les renouvellements.');
  if(!activeAcademicPeriod.renewalsOpen) throw AppError('La période de renouvellement est fermée. Un administrateur doit l’ouvrir.');
  const snap=await snapshot();
  const student=snap.students.find(row=>row.id===studentId);
  if(!student||!Scope.students(snap).some(row=>row.id===studentId)) throw AppError('Résident introuvable ou hors de votre périmètre.');
  if(student.statut!=='actif') throw AppError('Le renouvellement annuel est réservé aux résidents actifs.');
  const year=currentAcademicYear();
  const {academic,dossier,previous}=await ensureStudentAnnualRecords(student,year);
  const suggestedLevel=previous?.decision==='admis'?nextAcademicLevel(previous.niveau):previous?.niveau||academic.niveau;
  const initialLevel=previous?.decision==='admis'&&academic.niveau.toLocaleLowerCase('fr')===previous.niveau.toLocaleLowerCase('fr')?suggestedLevel:academic.niveau||suggestedLevel;
  const levels=[...new Set([...NIVEAUX,academic.niveau,suggestedLevel].filter(Boolean))];
  const priorDecision=previous?.decision||'en_attente';
  const body=`<div class="fgrid" data-renewal-form>
    <div class="field full"><label>Année universitaire</label><output class="inp" style="display:flex;align-items:center;font-weight:700">${esc(year)}</output></div>
    <div class="field"><label>Filière <span class="req">*</span></label><input class="inp" name="filiere" required value="${esc(academic.filiere)}"></div>
    <div class="field"><label>Faculté / Institut <span class="req">*</span></label><input class="inp" name="faculte" required value="${esc(academic.faculte)}"></div>
    <div class="field"><label>Niveau d’étude <span class="req">*</span></label><input class="inp" name="niveau" list="renewal-level-options" required value="${esc(initialLevel)}"><datalist id="renewal-level-options">${levels.map(level=>`<option value="${esc(level)}">`).join('')}</datalist></div>
    ${previous?`<div class="field"><label>Résultat de ${esc(previous.academicYear)}</label><select class="inp" name="previousDecision">${ACADEMIC_DECISIONS.map(([key,label])=>`<option value="${key}" ${key===priorDecision?'selected':''}>${label}</option>`).join('')}</select></div>`:''}
    <div class="field"><label>État du dossier d’hébergement</label><select class="inp" name="housingStatus">${HOUSING_DOSSIER_STATUSES.filter(([key])=>key!=='clos').map(([key,label])=>`<option value="${key}" ${key===dossier.status?'selected':''}>${label}</option>`).join('')}</select></div>
    <div class="field full"><label>Notes du dossier</label><textarea class="inp" name="notes" rows="3">${esc(dossier.notes||'')}</textarea></div>
    <div class="field full" style="color:var(--muted);font-size:11px">Si l’année précédente est validée, le niveau supérieur est suggéré. L’historique annuel reste conservé.</div>
  </div>`;
  Modal.open({title:'Renouvellement annuel',sub:`${student.prenom} ${student.nom} · ${year}`,wide:true,body,
    footer:'<button class="btn btn-ghost" data-mclose>Annuler</button><button class="btn btn-primary" data-save-renewal>Enregistrer le renouvellement</button>',
    onMount(overlay){
      const form=overlay.querySelector('.m-form');
      const previousDecisionField=form.querySelector('[name="previousDecision"]');
      const levelField=form.querySelector('[name="niveau"]');
      previousDecisionField?.addEventListener('change',()=>{
        if(!previous) return;
        levelField.value=previousDecisionField.value==='admis'?nextAcademicLevel(previous.niveau):previous.niveau;
      });
      overlay.querySelector('[data-save-renewal]').addEventListener('click',event=>{
        event.preventDefault();
        safe(async()=>{
          const values=Object.fromEntries(new FormData(form).entries());
          const filiere=String(values.filiere||'').trim(),faculte=String(values.faculte||'').trim(),niveau=String(values.niveau||'').trim();
          if(!filiere||!faculte||!niveau) throw AppError('La filière, la faculté et le niveau d’étude sont obligatoires.');
          const decision=String(values.previousDecision||'en_attente');
          const status=String(values.housingStatus||'a_renouveler');
          if(!HOUSING_DOSSIER_STATUSES.some(([key])=>key===status&&key!=='clos')) throw AppError('État du dossier invalide.');
          if(previous){
            if(!ACADEMIC_DECISIONS.some(([key])=>key===decision)) throw AppError('Résultat académique invalide.');
            const expected=decision==='admis'?nextAcademicLevel(previous.niveau):previous.niveau;
            if(decision!=='en_attente'&&niveau.toLocaleLowerCase('fr')!==expected.toLocaleLowerCase('fr')){
              throw AppError(decision==='admis'?`Après admission, le niveau suggéré est ${expected}. Corrigez le niveau ou le résultat.`:`En cas de redoublement, le niveau doit rester ${previous.niveau}.`);
            }
          }
          const academicData={
            annualRecordId:academic.id,
            filiere,faculte,niveau,
            previousRecordId:previous?.id||null,
            previousDecision:previous?decision:null
          };
          await renewalBridge().updateDossier(dossier.id,status,String(values.notes||'').trim(),academicData);
          Modal.close();
          toast('Renouvellement annuel enregistré.','success');
          await refresh();
        });
      });
    }
  });
}

async function openRenewalTracking(){
  if(!Session.user) throw AppError('Connectez-vous pour consulter les renouvellements.');
  showView('renewal-tracking');
}
function renewalEventLabel(event){
  const labels={
    campagne_creee:'Campagne créée',campagne_dates_modifiees:'Dates de campagne modifiées',
    campagne_ouverte:'Campagne ouverte',campagne_suspendue:'Campagne suspendue',campagne_cloturee:'Campagne clôturée',
    dossier_a_renouveler:'Dossier remis à renouveler',dossier_en_preparation:'Dossier en préparation',
    dossier_incomplet:'Dossier incomplet',dossier_soumis:'Dossier soumis',dossier_accepte:'Renouvellement accepté',
    dossier_academique_modifie:'Dossier académique modifié',
    dossier_refuse:'Renouvellement refusé',affectation_proposee:'Chambre proposée',
    affectation_en_attente:'Affectation mise en attente',affectation_reconduite:'Chambre reconduite',
    affectation_modifiee:'Changement de chambre confirmé',renouvellement_cloture:'Renouvellement clôturé',
    cle_remise:'Clé remise',cle_restituee:'Clé restituée'
  };
  return labels[event.type]||event.type;
}
function renewalKeyStatus(studentId,dossier,snap){
  const campaign=(snap.renewalCampaigns||[]).find(item=>item.id===dossier?.campaignId);
  const throughYear=academicYearStart(campaign?.academicYear||dossier?.academicYear||'');
  const events=(snap.renewalEvents||[]).filter(event=>{
    if(event.studentId!==studentId||!['cle_remise','cle_restituee'].includes(event.type)) return false;
    const eventCampaign=(snap.renewalCampaigns||[]).find(item=>item.id===event.campaignId);
    const eventYear=academicYearStart(eventCampaign?.academicYear||'');
    return throughYear===null||eventYear===null||eventYear<=throughYear;
  }).sort((a,b)=>(b.sequence||0)-(a.sequence||0));
  const latest=events[0]||null;
  const student=snap.students.find(item=>item.id===studentId);
  const hasCurrentRoom=student?.statut==='actif'
    &&snap.rooms.some(room=>room.id===student.chambreId);
  const state=renewalKeyDisplayState({
    latest,hasCurrentRoom,assignmentStatus:dossier?.assignmentStatus,
    assignmentConfirmedAt:dossier?.assignmentConfirmedAt
  });
  return {state,latest,events};
}
function renewalKeyBadge(state){
  const map={
    remise:['ok','Clé remise'],
    restituee:['warn','Clé restituée'],
    non_remise:['warn','Clé non remise']
  };
  const [tone,label]=map[state]||map.non_remise;
  return `<span class="renewal-status-badge ${tone}">${label}</span>`;
}
async function openRenewalDossier(studentId,campaignId=activeAcademicPeriod.campaignId){
  if(!Session.user) throw AppError('Connectez-vous pour gérer les renouvellements.');
  let snap=await loadRenewalSnapshot();
  const campaign=(snap.renewalCampaigns||[]).find(item=>item.id===campaignId);
  let student=snap.students.find(item=>item.id===studentId);
  if(!campaign||!student) throw AppError('Campagne ou résident introuvable.');
  if(student.statut!=='actif'&&campaign.status!=='cloturee') throw AppError('Le renouvellement annuel est réservé aux résidents actifs.');
  let dossier=(snap.housingDossiers||[]).find(item=>item.studentId===student.id&&item.academicYear===campaign.academicYear);
  if(!dossier){
    if(campaign.status!=='ouverte') throw AppError('Aucun dossier n’a été enregistré pour ce résident dans cette campagne clôturée.');
    if(window.hebergia?.renewals?.ensureDossier){
      dossier=await renewalBridge().ensureDossier(student.id,campaign.id);
      snap=await loadRenewalSnapshot();
      student=snap.students.find(item=>item.id===studentId);
    }else{
      const ensured=await ensureStudentAnnualRecords(student,campaign.academicYear);
      dossier=ensured.dossier;
    }
  }
  const academic=(snap.academicRecords||[]).find(item=>item.studentId===student.id&&item.academicYear===campaign.academicYear);
  const currentRoom=snap.rooms.find(item=>item.id===student.chambreId);
  const assignedRoom=snap.rooms.find(item=>item.id===dossier.assignedRoomId);
  const targetRoomId=dossier.targetRoomId||dossier.assignedRoomId||student.chambreId||'';
  const key=renewalKeyStatus(student.id,dossier,snap);
  const campaignOpen=campaign.status==='ouverte';
  const canEdit=campaignOpen&&dossier.renewalStatus!=='cloture';
  const roomOptions=snap.rooms.slice().sort((a,b)=>compareNames(a.bloc,b.bloc)||compareNames(a.numero,b.numero)).map(room=>{
    const others=occupantIds(snap,room.id).filter(item=>item.id!==student.id).length;
    const available=Math.max(0,room.capacite-others);
    const compatible=isBlockGenderCompatible(snap,student,room);
    const disabled=room.statut==='hors_service'||available===0||!compatible;
    const suffix=room.statut==='hors_service'?' · hors service':!compatible?' · non compatible':` · capacité ${room.capacite} · places disponibles ${available}`;
    return `<option value="${esc(room.id)}" ${room.id===targetRoomId?'selected':''} ${disabled&&room.id!==student.chambreId?'disabled':''}>${esc(room.bloc)} · Chambre ${esc(room.numero)}${suffix}</option>`;
  }).join('');
  const eventMap=new Map((snap.renewalEvents||[]).filter(event=>event.dossierId===dossier.id||key.events.some(item=>item.id===event.id)).map(event=>[event.id,event]));
  const eventRows=[...eventMap.values()].sort((a,b)=>b.occurredAt.localeCompare(a.occurredAt));
  const assignmentStatus=renewalAssignmentDisplayStatus(student,dossier,snap);
  const roomState=assignmentStatus==='confirmee'
    ?`<span class="renewal-status-badge ok">${dossier.assignmentStatus==='confirmee'&&dossier.assignmentAction==='modifiee'?'Installation confirmée':'Chambre actuelle confirmée'}</span>`
    :assignmentStatus==='en_attente'
      ?'<span class="renewal-status-badge warn">Affectation en attente</span>'
      :'<span class="renewal-status-badge neutral">Affectation à confirmer</span>';
  const body=`<div class="renewal-dialog-grid">
    <section class="renewal-dialog-section"><h4>Dossier annuel</h4>
      <div class="field"><label>État du renouvellement</label>${canEdit?`<select class="inp" name="housingStatus">${HOUSING_DOSSIER_STATUSES.filter(([status])=>status!=='clos').map(([status,label])=>`<option value="${status}" ${status===dossier.status?'selected':''}>${label}</option>`).join('')}</select>`:`<div class="inp">${esc(renewalDossierDisplayLabel(dossier,campaign.status))}</div>`}</div>
      <div class="field" style="margin-top:9px"><label>Filière · niveau</label><div class="inp">${esc(academic?.filiere||student.filiere||'—')} · ${esc(academic?.niveau||student.niveau||'—')}</div></div>
      <div class="field" style="margin-top:9px"><label>Notes</label><textarea class="inp" name="notes" rows="3" ${canEdit?'':'disabled'}>${esc(dossier.notes||'')}</textarea></div>
    </section>
    <section class="renewal-dialog-section"><h4>Affectation de chambre</h4>
      <div class="field"><label>Chambre actuelle</label><div class="inp">${currentRoom?`${esc(currentRoom.bloc)} · Chambre ${esc(currentRoom.numero)} · capacité ${currentRoom.capacite}`:'Aucune chambre affectée'}</div></div>
      <div class="field" style="margin-top:9px"><label>Chambre retenue / cible</label><select class="inp" name="targetRoomId" ${canEdit&&dossier.status==='accepte'?'':'disabled'}><option value="">Mettre l’affectation en attente</option>${roomOptions}</select></div>
      <div class="field" style="margin-top:9px"><label>Motif du changement (si nécessaire)</label><textarea class="inp" name="assignmentReason" rows="2" ${canEdit&&dossier.status==='accepte'?'':'disabled'}>${esc(dossier.assignmentReason||'')}</textarea></div>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px">${roomState}${assignedRoom?`<span class="student-renewal-note">${esc(assignedRoom.bloc)} · Chambre ${esc(assignedRoom.numero)}</span>`:''}</div>
      <div class="renewal-key-actions">${renewalKeyBadge(key.state)}
        ${campaignOpen&&dossier.status==='accepte'&&dossier.assignmentStatus==='confirmee'?`${key.state==='remise'?'<button class="btn btn-ghost btn-sm" type="button" data-key-operation="restitution">Enregistrer la restitution</button>':'<button class="btn btn-primary btn-sm" type="button" data-key-operation="remise">Enregistrer la remise</button>'}`:''}
      </div>
      <p class="report-note">${key.state==='remise'?'Un résident actif affecté à une chambre est considéré installé; la clé est donc considérée remise.':key.state==='non_remise'?'Aucune remise de clé n’est enregistrée; une restitution sera refusée sans remise préalable.':'Les opérations de clé n’empêchent pas la clôture du dossier.'}</p>
    </section>
    <section class="renewal-dialog-section full"><h4>Suivi et clôture</h4>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px"><span class="renewal-status-badge ${dossier.renewalStatus==='cloture'?'ok':'neutral'}">${dossier.renewalStatus==='cloture'?'Renouvellement clôturé':'Renouvellement en cours'}</span>
        ${assignmentStatus==='a_confirmer'&&dossier.status==='accepte'&&campaignOpen?'<button class="btn btn-primary btn-sm" type="button" data-confirm-installation>Confirmer l’installation</button>':''}
        ${dossier.status==='accepte'&&assignmentStatus==='confirmee'&&dossier.renewalStatus!=='cloture'&&campaignOpen?'<button class="btn btn-ghost btn-sm" type="button" data-close-renewal>Clôturer le renouvellement</button>':''}
        ${!campaignOpen?`<span class="student-renewal-note">Campagne ${esc(renewalCampaignStatusLabel(campaign.status).toLowerCase())} : dossier en lecture seule.</span>`:''}
      </div>
      ${eventRows.length?`<ul class="renewal-event-list">${eventRows.map(event=>{const eventCampaign=(snap.renewalCampaigns||[]).find(item=>item.id===event.campaignId);return `<li><div class="renewal-event-copy"><strong>${esc(renewalEventLabel(event))}</strong><span>${fmtDateTime(event.occurredAt)}${eventCampaign?` · ${esc(eventCampaign.academicYear)}`:''} · ${esc(event.actorName)}${event.reason?` · ${esc(event.reason)}`:''}</span></div>${['cle_remise','cle_restituee'].includes(event.type)?`<button class="btn btn-ghost btn-sm" type="button" data-print-key-receipt="${esc(event.id)}">Imprimer le récépissé</button>`:''}</li>`;}).join('')}</ul>`:'<div class="empty">Aucun événement enregistré pour ce dossier.</div>'}
    </section>
    <section class="renewal-dialog-section full"><div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap"><span class="student-renewal-note">Année universitaire ${esc(campaign.academicYear)}</span>
      <span><button class="btn btn-primary btn-sm" type="button" data-save-renewal-dossier ${canEdit?'':'disabled'}>Enregistrer le dossier</button> <button class="btn btn-ghost btn-sm" type="button" data-print-renewal-dossier>Imprimer la fiche</button></span>
    </div></section>
  </div>`;
  Modal.open({title:'Fiche de renouvellement',sub:`${student.prenom} ${student.nom} · ${student.matricule}`,wide:true,body,footer:'<button class="btn btn-ghost" data-mclose>Fermer</button>',onMount(overlay){
    const refreshModal=async()=>{Modal.close();await refresh();await openRenewalDossier(student.id,campaign.id);};
    overlay.querySelector('[data-save-renewal-dossier]')?.addEventListener('click',()=>safe(async()=>{
      const values=Object.fromEntries(new FormData(overlay.querySelector('.m-form')).entries());
      const status=String(values.housingStatus||dossier.status);
      await renewalBridge().updateDossier(dossier.id,status,String(values.notes||''));
      if(status==='accepte'){
        await renewalBridge().setAssignment(dossier.id,String(values.targetRoomId||'')||null,String(values.assignmentReason||''));
      }
      toast('Dossier de renouvellement enregistré.','success');
      await refreshModal();
    }));
    overlay.querySelector('[data-confirm-installation]')?.addEventListener('click',()=>safe(async()=>{
      if(!(await confirmDialog({title:'Confirmer l’installation ?',message:'La chambre actuelle sera remplacée par la chambre cible et le mouvement sera enregistré dans l’historique.',ok:'Confirmer l’installation'}))) return;
      await renewalBridge().confirmAssignment(dossier.id);
      toast('Installation confirmée.','success');
      await refreshModal();
    }));
    overlay.querySelector('[data-close-renewal]')?.addEventListener('click',()=>safe(async()=>{
      if(!(await confirmDialog({title:'Clôturer le renouvellement ?',message:'Le dossier sera clôturé. Les opérations de remise ou restitution de clé resteront facultatives.',ok:'Clôturer'}))) return;
      await renewalBridge().closeDossier(dossier.id);
      toast('Renouvellement clôturé.','success');
      await refreshModal();
    }));
    overlay.querySelectorAll('[data-key-operation]').forEach(button=>button.addEventListener('click',()=>safe(async()=>{
      const operation=button.dataset.keyOperation;
      const label=operation==='remise'?'remise de clé':'restitution de clé';
      if(!(await confirmDialog({title:`Confirmer la ${label} ?`,message:`Confirmez que la ${label} a bien eu lieu et sera enregistrée à la date et à l’heure actuelles.`,ok:'Confirmer'}))) return;
      await renewalBridge().recordKeyOperation(dossier.id,operation,'');
      toast(operation==='remise'?'Clé remise enregistrée.':'Clé restituée enregistrée.','success');
      await refreshModal();
    })));
    overlay.querySelectorAll('[data-print-key-receipt]').forEach(button=>button.addEventListener('click',()=>safe(()=>printRenewalKeyReceipt(snap,student,campaign,dossier,button.dataset.printKeyReceipt))));
    overlay.querySelector('[data-print-renewal-dossier]')?.addEventListener('click',()=>safe(()=>printRenewalDossier(snap,student,campaign,dossier)));
  }});
}
async function printRenewalDossier(snap,student,campaign,dossier){
  const room=snap.rooms.find(item=>item.id===dossier.assignedRoomId)||snap.rooms.find(item=>item.id===student.chambreId);
  const key=renewalKeyStatus(student.id,dossier,snap);
  const content=`<h2 class="resident-document-title">Fiche de renouvellement</h2><p class="resident-document-date">Année universitaire ${esc(campaign.academicYear)}</p><div class="resident-document-facts">
    <div class="resident-document-fact"><span>Résident</span><strong>${esc(student.nom)} ${esc(student.prenom)}</strong></div>
    <div class="resident-document-fact"><span>Matricule</span><strong>${esc(student.matricule)}</strong></div>
    <div class="resident-document-fact"><span>État du dossier</span><strong>${esc(renewalDossierDisplayLabel(dossier,campaign.status))}</strong></div>
    <div class="resident-document-fact"><span>Affectation</span><strong>${room?`${esc(room.bloc)} · Chambre ${esc(room.numero)} · capacité ${room.capacite}`:'En attente'}</strong></div>
    <div class="resident-document-fact"><span>Clé</span><strong>${esc(renewalKeyBadgeText(key.state))}</strong></div>
    <div class="resident-document-fact"><span>Renouvellement</span><strong>${dossier.renewalStatus==='cloture'?'Clôturé':'En cours'}</strong></div>
  </div><p class="resident-document-copy">${esc(dossier.notes||'Aucune note')}</p><div class="resident-document-signature"><div class="resident-document-signature-block"><strong>Signature du résident</strong><span>Nom et signature</span></div><div class="resident-document-signature-block"><strong>Service de l’administration</strong><span>Visa et cachet</span></div></div>`;
  printResidentDocument(residentDocumentShell('Fiche individuelle de renouvellement',content));
}
function renewalKeyBadgeText(state){
  return ({remise:'Clé remise',restituee:'Clé restituée',non_remise:'Clé non remise'})[state]||'Clé non remise';
}
function printRenewalKeyReceipt(snap,student,campaign,dossier,eventId){
  const event=(snap.renewalEvents||[]).find(item=>item.id===eventId);
  if(!event||!['cle_remise','cle_restituee'].includes(event.type)) throw AppError('Mouvement de clé introuvable.');
  const eventCampaign=(snap.renewalCampaigns||[]).find(item=>item.id===event.campaignId)||campaign;
  const eventDossier=(snap.housingDossiers||[]).find(item=>item.id===event.dossierId)||dossier;
  const eventStudent=snap.students.find(item=>item.id===event.studentId)||student;
  const room=snap.rooms.find(item=>item.id===event.toRoomId)||snap.rooms.find(item=>item.id===eventDossier.assignedRoomId)||snap.rooms.find(item=>item.id===eventStudent.chambreId);
  const action=event.type==='cle_remise'?'remise':'restitution';
  const content=`<h2 class="resident-document-title">Récépissé de ${action} de clé</h2><p class="resident-document-date">Établi le ${fmtDateTime(event.occurredAt)}</p><div class="resident-document-facts">
    <div class="resident-document-fact"><span>Résident</span><strong>${esc(eventStudent.nom)} ${esc(eventStudent.prenom)}</strong></div>
    <div class="resident-document-fact"><span>Matricule</span><strong>${esc(eventStudent.matricule)}</strong></div>
    <div class="resident-document-fact"><span>Année universitaire</span><strong>${esc(eventCampaign.academicYear)}</strong></div>
    <div class="resident-document-fact"><span>Chambre</span><strong>${room?`${esc(room.bloc)} · ${esc(room.numero)}`:'—'}</strong></div>
    <div class="resident-document-fact"><span>Opération</span><strong>${event.type==='cle_remise'?'Clé remise':'Clé restituée'}</strong></div>
    <div class="resident-document-fact"><span>Enregistré par</span><strong>${esc(event.actorName)}</strong></div>
  </div><p class="resident-document-copy">Le présent récépissé confirme que l’opération de ${action} de clé ci-dessus a été constatée et enregistrée.</p><div class="resident-document-signature"><div class="resident-document-signature-block"><strong>Signature du résident</strong><span>Nom et signature</span></div><div class="resident-document-signature-block"><strong>${esc(event.actorName)}</strong><span>Signature et cachet</span></div></div>`;
  printResidentDocument(residentDocumentShell('Récépissé de mouvement de clé',content));
}
function printRenewalCampaignReport(snap,campaign,rows){
  const sorted=rows.slice().sort((a,b)=>{
    const aRoom=snap.rooms.find(item=>item.id===(a.dossier?.assignedRoomId||a.student.chambreId));
    const bRoom=snap.rooms.find(item=>item.id===(b.dossier?.assignedRoomId||b.student.chambreId));
    return compareNames(aRoom?.bloc||'',bRoom?.bloc||'')||compareNames(aRoom?.numero||'',bRoom?.numero||'')||compareNames(a.student.nom,b.student.nom);
  });
  const body=sorted.map(({student,dossier})=>{
    const room=snap.rooms.find(item=>item.id===(dossier?.assignedRoomId||student.chambreId));
    const key=renewalKeyStatus(student.id,dossier,snap);
    return `<tr><td>${esc(student.nom)} ${esc(student.prenom)}</td><td>${esc(student.matricule)}</td><td>${room?`${esc(room.bloc)} · ${esc(room.numero)}`:'—'}</td><td>${esc(renewalDossierDisplayLabel(dossier,campaign.status))}</td><td>${esc(renewalKeyBadgeText(key.state))}</td></tr>`;
  }).join('');
  const roomTable=`<table style="width:100%;border-collapse:collapse;font:9pt Arial,sans-serif"><thead><tr><th style="text-align:left;border-bottom:1px solid #9aa7b2;padding:5px">Résident</th><th style="text-align:left;border-bottom:1px solid #9aa7b2;padding:5px">Matricule</th><th style="text-align:left;border-bottom:1px solid #9aa7b2;padding:5px">Bloc · chambre</th><th style="text-align:left;border-bottom:1px solid #9aa7b2;padding:5px">Dossier</th><th style="text-align:left;border-bottom:1px solid #9aa7b2;padding:5px">Clé</th></tr></thead><tbody>${body}</tbody></table>`;
  const changes=sorted.filter(({dossier})=>dossier?.assignmentAction==='modifiee');
  const changeTable=`<h3>Changements de chambre</h3>${changes.length?`<table style="width:100%;border-collapse:collapse;font:9pt Arial,sans-serif"><thead><tr><th style="text-align:left;border-bottom:1px solid #9aa7b2;padding:5px">Résident</th><th style="text-align:left;border-bottom:1px solid #9aa7b2;padding:5px">Chambre précédente</th><th style="text-align:left;border-bottom:1px solid #9aa7b2;padding:5px">Nouvelle chambre</th><th style="text-align:left;border-bottom:1px solid #9aa7b2;padding:5px">Motif</th></tr></thead><tbody>${changes.map(({student,dossier})=>{const movement=(snap.history||[]).filter(item=>item.dossierId===dossier.id).sort((a,b)=>b.date.localeCompare(a.date))[0];const room=snap.rooms.find(item=>item.id===dossier.assignedRoomId);return `<tr><td>${esc(student.nom)} ${esc(student.prenom)}</td><td>${esc(movement?.fromRoomLabel||'—')}</td><td>${room?`${esc(room.bloc)} · ${esc(room.numero)}`:'—'}</td><td>${esc(dossier.assignmentReason||'—')}</td></tr>`;}).join('')}</tbody></table>`:'<p>Aucun changement de chambre confirmé.</p>'}`;
  const studentIds=new Set(rows.map(row=>row.student.id));
  const keyEvents=(snap.renewalEvents||[]).filter(event=>event.campaignId===campaign.id&&studentIds.has(event.studentId)&&['cle_remise','cle_restituee'].includes(event.type)).sort((a,b)=>a.occurredAt.localeCompare(b.occurredAt));
  const keyTable=`<h3>Mouvements de clés</h3>${keyEvents.length?`<table style="width:100%;border-collapse:collapse;font:9pt Arial,sans-serif"><thead><tr><th style="text-align:left;border-bottom:1px solid #9aa7b2;padding:5px">Date et heure</th><th style="text-align:left;border-bottom:1px solid #9aa7b2;padding:5px">Opération</th><th style="text-align:left;border-bottom:1px solid #9aa7b2;padding:5px">Résident</th><th style="text-align:left;border-bottom:1px solid #9aa7b2;padding:5px">Bloc · chambre</th><th style="text-align:left;border-bottom:1px solid #9aa7b2;padding:5px">Agent</th></tr></thead><tbody>${keyEvents.map(event=>{const student=snap.students.find(item=>item.id===event.studentId),room=snap.rooms.find(item=>item.id===event.toRoomId);return `<tr><td>${fmtDateTime(event.occurredAt)}</td><td>${esc(renewalEventLabel(event))}</td><td>${student?`${esc(student.nom)} ${esc(student.prenom)}`:'—'}</td><td>${room?`${esc(room.bloc)} · ${esc(room.numero)}`:'—'}</td><td>${esc(event.actorName)}</td></tr>`;}).join('')}</tbody></table>`:'<p>Aucun mouvement de clé enregistré.</p>'}`;
  const content=`<h2 class="resident-document-title">Rapport de renouvellement</h2><p class="resident-document-date">Campagne ${esc(campaign.academicYear)} · ${fmtDate(campaign.startDate)} — ${fmtDate(campaign.endDate)}</p><h3>Liste par bloc et chambre</h3>${roomTable}${changeTable}${keyTable}`;
  printResidentDocument(residentDocumentShell('Rapport récapitulatif de campagne',content));
}
function openRenewalCampaignForm(){
  requireAdmin();
  const campaigns=Store.list('renewalCampaigns');
  safe(async()=>{
    const existing=await campaigns;
    let startYear=Number(currentAcademicYear().slice(0,4));
    while(existing.some(campaign=>campaign.academicYear===`${startYear}/${startYear+1}`)) startYear++;
    const year=`${startYear}/${startYear+1}`;
    Modal.open({title:'Nouvelle campagne de renouvellement',sub:year,body:`<div class="fgrid">
      <div class="field"><label>Année universitaire</label><input class="inp" name="academicYear" value="${year}" readonly></div>
      <div class="field"><label>Date de début</label><input class="inp" type="date" name="startDate" value="${startYear}-09-01" required></div>
      <div class="field"><label>Date de fin</label><input class="inp" type="date" name="endDate" value="${startYear+1}-06-30" required></div>
    </div><p class="report-note">La campagne sera créée en brouillon. Vous pourrez l’ouvrir après vérification des dates.</p>`,
      footer:'<button class="btn btn-ghost" data-mclose>Annuler</button><button class="btn btn-primary" data-save-campaign>Créer la campagne</button>',
      onMount(overlay){overlay.querySelector('[data-save-campaign]').addEventListener('click',()=>safe(async()=>{
        const values=Object.fromEntries(new FormData(overlay.querySelector('.m-form')).entries());
        const created=await renewalBridge().createCampaign({academicYear:values.academicYear,startDate:values.startDate,endDate:values.endDate});
        activeAcademicPeriod.campaignId=created.id;
        activeAcademicPeriod.year=created.academicYear;
        activeAcademicPeriod.campaignStatus=created.status;
        activeAcademicPeriod.renewalsOpen=false;
        Modal.close();toast('Campagne créée en brouillon.','success');await refresh();
      }));}
    });
  });
}
function openRenewalCampaignDates(campaign){
  requireAdmin();
  Modal.open({title:'Dates de la campagne',sub:campaign.academicYear,body:`<div class="fgrid">
    <div class="field"><label>Date de début</label><input class="inp" type="date" name="startDate" value="${esc(campaign.startDate||'')}" required></div>
    <div class="field"><label>Date de fin</label><input class="inp" type="date" name="endDate" value="${esc(campaign.endDate||'')}" required></div>
  </div>`,footer:'<button class="btn btn-ghost" data-mclose>Annuler</button><button class="btn btn-primary" data-save-campaign-dates>Enregistrer les dates</button>',
  onMount(overlay){overlay.querySelector('[data-save-campaign-dates]').addEventListener('click',()=>safe(async()=>{
    const values=Object.fromEntries(new FormData(overlay.querySelector('.m-form')).entries());
    await renewalBridge().updateCampaignDates(campaign.id,values.startDate,values.endDate);
    Modal.close();toast('Dates de campagne enregistrées.','success');await refresh();
  }));}});
}
async function exportRenewalCampaignExcel(snap,campaign,rows){
  const ExcelJS=await window.loadExcelJS();
  const workbook=new ExcelJS.Workbook();
  const columns=[
    {header:'Résident',key:'resident',width:28},{header:'Matricule',key:'matricule',width:18},
    {header:'Année',key:'year',width:15},{header:'Bloc',key:'block',width:18},
    {header:'Chambre',key:'room',width:14},{header:'Capacité réelle',key:'capacity',width:16},
    {header:'Places disponibles',key:'available',width:18},{header:'État du dossier',key:'status',width:20},
    {header:'Affectation',key:'assignment',width:18},{header:'Clé',key:'key',width:18},
    {header:'Date/heure de clôture',key:'closedAt',width:24}
  ];
  const enrich=({student,dossier})=>{
    const room=snap.rooms.find(item=>item.id===(dossier?.assignedRoomId||student.chambreId));
    const key=renewalKeyStatus(student.id,dossier,snap);
    const occupants=room?snap.students.filter(item=>item.statut==='actif'&&item.chambreId===room.id).length:0;
    return {
      resident:`${student.nom} ${student.prenom}`,matricule:student.matricule,year:campaign.academicYear,
      block:room?.bloc||'',room:room?.numero||'',capacity:room?.capacite??'',
      available:room?Math.max(0,room.capacite-occupants):'',
      status:renewalDossierDisplayLabel(dossier,campaign.status),assignment:renewalAssignmentDisplayLabel(student,dossier,snap),
      key:renewalKeyBadgeText(key.state),closedAt:dossier?.closedAt?fmtDateTime(dossier.closedAt):'',
      student,dossier,room,key
    };
  };
  const addSheet=(name,records)=>{
    const sheet=workbook.addWorksheet(name);
    sheet.columns=columns;
    for(const row of records) sheet.addRow(row);
    sheet.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};
    sheet.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF174B3E'}};
    sheet.autoFilter={from:{row:1,column:1},to:{row:1,column:columns.length}};
  };
  const enriched=rows.map(enrich);
  addSheet('Synthèse',enriched);
  addSheet('Par chambre',enriched.slice().sort((a,b)=>compareNames(a.block,b.block)||compareNames(a.room,b.room)||compareNames(a.resident,b.resident)));
  addSheet('Changements',enriched.filter(row=>row.dossier?.assignmentAction==='modifiee').map(row=>{
    const movement=(snap.history||[]).filter(item=>item.dossierId===row.dossier.id).sort((a,b)=>b.date.localeCompare(a.date))[0];
    return {...row,assignment:movement?.fromRoomLabel?`Depuis ${movement.fromRoomLabel} → ${row.block} ${row.room}`:`Modifiée · ${row.block} ${row.room}`};
  }));
  const currentStudentIds=new Set(rows.map(row=>row.student.id));
  const keyEvents=(snap.renewalEvents||[]).filter(event=>event.campaignId===campaign.id&&currentStudentIds.has(event.studentId)&&['cle_remise','cle_restituee'].includes(event.type)).sort((a,b)=>a.occurredAt.localeCompare(b.occurredAt));
  const keySheet=workbook.addWorksheet('Mouvements de clés');
  keySheet.columns=[
    {header:'Date et heure',key:'when',width:24},{header:'Année universitaire',key:'year',width:18},
    {header:'Opération',key:'action',width:20},{header:'Résident',key:'resident',width:28},
    {header:'Matricule',key:'matricule',width:18},{header:'Bloc',key:'block',width:18},
    {header:'Chambre',key:'room',width:14},{header:'Enregistré par',key:'actor',width:24}
  ];
  for(const event of keyEvents){
    const student=snap.students.find(item=>item.id===event.studentId);
    const campaignForEvent=(snap.renewalCampaigns||[]).find(item=>item.id===event.campaignId);
    const room=snap.rooms.find(item=>item.id===event.toRoomId);
    keySheet.addRow({when:fmtDateTime(event.occurredAt),year:campaignForEvent?.academicYear||'',action:renewalEventLabel(event),resident:student?`${student.nom} ${student.prenom}`:'',matricule:student?.matricule||'',block:room?.bloc||'',room:room?.numero||'',actor:event.actorName});
  }
  keySheet.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};
  keySheet.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF174B3E'}};
  keySheet.autoFilter={from:{row:1,column:1},to:{row:1,column:8}};
  const bytes=await workbook.xlsx.writeBuffer();
  const blob=new Blob([bytes],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
  const link=document.createElement('a');
  link.href=URL.createObjectURL(blob);
  link.download=`renouvellements-${campaign.academicYear.replace('/','-')}.xlsx`;
  link.click();
  URL.revokeObjectURL(link.href);
}
async function renderRenewalTracking(){
  const root=$('renewal-tracking-root');
  if(!root) return;
  const snap=await loadRenewalSnapshot();
  const campaigns=(snap.renewalCampaigns||[]).slice().sort((a,b)=>b.academicYear.localeCompare(a.academicYear));
  if(!campaigns.length){
    root.innerHTML=`<div class="card"><div class="card-b"><div class="empty">Aucune campagne de renouvellement n’est configurée.</div>${isAdmin()?'<button class="btn btn-primary" type="button" data-create-renewal-campaign>Créer une campagne</button>':''}</div></div>`;
    root.querySelector('[data-create-renewal-campaign]')?.addEventListener('click',()=>openRenewalCampaignForm());
    return;
  }
  let campaign=campaigns.find(item=>item.id===activeAcademicPeriod.campaignId)||campaigns.find(item=>item.status==='ouverte')||campaigns[0];
  activeAcademicPeriod.campaignId=campaign.id;
  activeAcademicPeriod.year=campaign.academicYear;
  activeAcademicPeriod.campaignStatus=campaign.status;
  activeAcademicPeriod.renewalsOpen=campaign.status==='ouverte';
  const rows=buildRenewalCampaignRows({
    campaign,
    students:snap.students,
    rooms:snap.rooms,
    dossiers:snap.housingDossiers||[],
    academicRecords:snap.academicRecords||[],
    isAdmin:isAdmin(),
    block:Session.bloc()
  }).sort((a,b)=>compareNames(a.student.nom,b.student.nom)||compareNames(a.student.prenom,b.student.prenom));
  const displayStatus=row=>renewalDossierDisplayStatus(row.dossier,campaign.status);
  const stats=summarizeRenewalCampaignRows(rows,campaign.status,
    (student,dossier)=>renewalAssignmentDisplayStatus(student,dossier,snap));
  const adminControls=isAdmin()?`<div style="display:flex;gap:7px;flex-wrap:wrap">${campaign.status==='brouillon'?'<button class="btn btn-ghost btn-sm" data-edit-campaign-dates>Dates</button><button class="btn btn-primary btn-sm" data-campaign-status="ouverte">Ouvrir</button>':''}${campaign.status==='ouverte'?'<button class="btn btn-ghost btn-sm" data-campaign-status="suspendue">Suspendre</button><button class="btn btn-danger btn-sm" data-campaign-status="cloturee">Clôturer la campagne</button>':''}${campaign.status==='suspendue'?'<button class="btn btn-ghost btn-sm" data-edit-campaign-dates>Dates</button><button class="btn btn-primary btn-sm" data-campaign-status="ouverte">Reprendre</button><button class="btn btn-danger btn-sm" data-campaign-status="cloturee">Clôturer la campagne</button>':''}${campaign.status==='cloturee'?'<span class="renewal-status-badge neutral">Campagne en lecture seule</span>':''}<button class="btn btn-ghost btn-sm" data-create-renewal-campaign>Nouvelle campagne</button></div>`:'';
  root.innerHTML=`<div class="card"><div class="card-h"><h3>${esc(VIEWS['renewal-tracking'][0])}</h3><span class="spacer"></span>${adminControls}</div><div class="card-b">
    <div class="renewal-campaign-toolbar"><div class="field"><label>Campagne universitaire</label><select class="inp" data-renewal-campaign>${campaigns.map(item=>`<option value="${esc(item.id)}" ${item.id===campaign.id?'selected':''}>${esc(item.academicYear)} · ${esc(renewalCampaignStatusLabel(item.status))}</option>`).join('')}</select></div>
      <div class="student-renewal-note">${campaign.startDate?`${fmtDate(campaign.startDate)} — ${fmtDate(campaign.endDate)}`:'Dates non renseignées'}</div>
      <button class="btn btn-ghost btn-sm" type="button" data-print-campaign>Imprimer le rapport</button><button class="btn btn-ghost btn-sm" type="button" data-export-campaign>Exporter Excel</button>
    </div>
    <div class="renewal-campaign-stats">
      <div class="renewal-stat"><span>Dossiers à traiter</span><strong>${stats.pending.toLocaleString('fr-FR')}</strong></div>
      <div class="renewal-stat"><span>Dossiers validés</span><strong>${stats.accepted.toLocaleString('fr-FR')}</strong></div>
      <div class="renewal-stat"><span>Clôturés sans décision</span><strong>${stats.closedWithoutDecision.toLocaleString('fr-FR')}</strong></div>
      <div class="renewal-stat"><span>Dossiers incomplets</span><strong>${stats.incomplete.toLocaleString('fr-FR')}</strong></div>
      <div class="renewal-stat"><span>Dossiers refusés</span><strong>${stats.refused.toLocaleString('fr-FR')}</strong></div>
      <div class="renewal-stat"><span>Chambres reconduites</span><strong>${stats.retained.toLocaleString('fr-FR')}</strong></div>
      <div class="renewal-stat"><span>Chambres modifiées</span><strong>${stats.changed.toLocaleString('fr-FR')}</strong></div>
    </div>
    <div class="renewal-campaign-toolbar"><div class="field"><label>Rechercher un résident</label><input class="inp" type="search" data-renewal-search placeholder="Nom, matricule, bloc ou chambre"></div><div class="field"><label>État du dossier</label><select class="inp" data-renewal-status-filter><option value="">Tous les états</option>${campaign.status==='cloturee'?'<option value="clos_sans_decision">Clôturé sans décision</option>':''}${campaign.status!=='ouverte'?'<option value="non_ouverte">Campagne non ouverte</option>':''}${HOUSING_DOSSIER_STATUSES.filter(([status])=>status!=='clos'&&(status!=='a_renouveler'||campaign.status==='ouverte')&&!(campaign.status==='cloturee'&&RENEWAL_PENDING_STATUSES.includes(status))).map(([status,label])=>`<option value="${status}">${label}</option>`).join('')}</select></div>${isAdmin()?`<div class="field"><label>Bloc</label><select class="inp" data-renewal-block-filter><option value="">Tous les blocs</option>${[...new Set(snap.rooms.map(room=>room.bloc))].sort(compareNames).map(block=>`<option value="${esc(block)}">${esc(block)}</option>`).join('')}</select></div>`:''}<div class="field"><label>Affectation</label><select class="inp" data-renewal-assignment-filter><option value="">Toutes</option><option value="a_decider">À décider</option><option value="en_attente">En attente</option><option value="a_confirmer">À confirmer</option><option value="confirmee">Confirmée</option></select></div><div class="field"><label>Clé</label><select class="inp" data-renewal-key-filter><option value="">Tous les états</option><option value="remise">Remise</option><option value="restituee">Restituée</option><option value="non_remise">Non remise</option></select></div></div>
    <div data-renewal-results></div>
  </div></div>`;
  root.querySelector('[data-renewal-campaign]')?.addEventListener('change',event=>{
    const selected=campaigns.find(item=>item.id===event.target.value);
    if(!selected)return;
    activeAcademicPeriod.campaignId=selected.id;
    activeAcademicPeriod.year=selected.academicYear;
    activeAcademicPeriod.campaignStatus=selected.status;
    activeAcademicPeriod.renewalsOpen=selected.status==='ouverte';
    safe(refresh);
  });
  root.querySelector('[data-create-renewal-campaign]')?.addEventListener('click',()=>openRenewalCampaignForm());
  root.querySelector('[data-edit-campaign-dates]')?.addEventListener('click',()=>openRenewalCampaignDates(campaign));
  root.querySelectorAll('[data-campaign-status]').forEach(button=>button.addEventListener('click',()=>safe(async()=>{
    const status=button.dataset.campaignStatus;
    const label=renewalCampaignStatusLabel(status).toLocaleLowerCase('fr');
    if(!(await confirmDialog({title:`${label[0].toLocaleUpperCase('fr')}${label.slice(1)} la campagne ?`,message:`La campagne ${campaign.academicYear} passera à l’état « ${label} ».`,ok:'Confirmer',danger:status==='cloturee'})))return;
    await renewalBridge().setCampaignStatus(campaign.id,status);
    campaign.status=status;
    activeAcademicPeriod.campaignId=campaign.id;
    activeAcademicPeriod.year=campaign.academicYear;
    activeAcademicPeriod.campaignStatus=status;
    activeAcademicPeriod.renewalsOpen=status==='ouverte';
    toast(`Campagne ${label}.`,'success');
    await refresh();
  })));
  root.querySelector('[data-print-campaign]')?.addEventListener('click',()=>safe(()=>printRenewalCampaignReport(snap,campaign,rows)));
  root.querySelector('[data-export-campaign]')?.addEventListener('click',()=>safe(()=>exportRenewalCampaignExcel(snap,campaign,rows)));
  const results=root.querySelector('[data-renewal-results]');
  const search=root.querySelector('[data-renewal-search]');
  const statusFilter=root.querySelector('[data-renewal-status-filter]');
  const blockFilter=root.querySelector('[data-renewal-block-filter]');
  const assignmentFilter=root.querySelector('[data-renewal-assignment-filter]');
  const keyFilter=root.querySelector('[data-renewal-key-filter]');
  const priority=new Map(HOUSING_DOSSIER_STATUSES.map(([status],index)=>[status,index]));
  let page=1;
  let pageSize=50;
  const renderRows=()=>{
    const query=search.value.trim().toLocaleLowerCase('fr'),selectedStatus=statusFilter.value;
    const selectedBlock=blockFilter?.value||'',selectedAssignment=assignmentFilter.value,selectedKey=keyFilter.value;
    const filtered=rows.filter(({student,dossier})=>{
      const room=snap.rooms.find(item=>item.id===student.chambreId);
      const searchable=`${student.nom} ${student.prenom} ${student.matricule} ${room?.bloc||''} ${room?.numero||''}`.toLocaleLowerCase('fr');
      const assignment=renewalAssignmentDisplayStatus(student,dossier,snap);
      const key=renewalKeyStatus(student.id,dossier,snap).state;
      return searchable.includes(query)
        &&(!selectedStatus||displayStatus({dossier})===selectedStatus)
        &&(!selectedBlock||room?.bloc===selectedBlock)
        &&(!selectedAssignment||assignment===selectedAssignment)
        &&(!selectedKey||key===selectedKey);
    }).sort((a,b)=>(priority.get(displayStatus(a))??0)-(priority.get(displayStatus(b))??0)||compareNames(a.student.nom,b.student.nom));
    const pagination=paginateItems(filtered,page,pageSize);
    page=pagination.page;
    const pageCount=Math.max(1,pagination.pageCount);
    results.innerHTML=`${pagination.total?`<div class="tbl-wrap"><table class="renewal-tracking"><thead><tr><th>Résident</th><th>Bloc · Chambre</th><th>Capacité</th><th>État du dossier</th><th>Affectation</th><th>Clé</th><th></th></tr></thead><tbody>${pagination.items.map(({student,dossier,academic})=>{
      const room=snap.rooms.find(item=>item.id===(dossier?.assignedRoomId||student.chambreId));
      const key=renewalKeyStatus(student.id,dossier,snap);
      const assignment=renewalAssignmentDisplayLabel(student,dossier,snap);
      return `<tr><td><button type="button" class="resident-link resident-name ${studentGenderClass(student.sexe)}" data-action="stu-open" data-id="${esc(student.id)}"><strong>${esc(student.nom)} ${esc(student.prenom)}</strong></button><span class="resident-matricule">${esc(student.matricule)}</span><span class="student-renewal-note">${esc(academic?.filiere||student.filiere||'')} · ${esc(academic?.niveau||student.niveau||'')}</span></td><td>${room?`${esc(room.bloc)} · ${esc(room.numero)}`:'—'}</td><td>${room?room.capacite:'—'}</td><td>${esc(renewalDossierDisplayLabel(dossier,campaign.status))}</td><td>${esc(assignment)}</td><td>${renewalKeyBadge(key.state)}</td><td><button class="btn btn-primary btn-sm" type="button" data-renewal-detail="${esc(student.id)}">Ouvrir le dossier</button></td></tr>`;
    }).join('')}</tbody></table></div>`:'<div class="empty">Aucun dossier ne correspond aux filtres.</div>'}
      <div class="table-pagination">
        <span>${pagination.total?`Affichage ${pagination.start+1}–${pagination.end} sur ${pagination.total} dossiers`:'Aucun résultat'}</span>
        <div class="table-pagination-controls">
          <label class="table-pagination-size">Par page
            <select class="inp" data-renewal-page-size aria-label="Nombre de dossiers par page">
              ${[25,50,100].map(size=>`<option value="${size}"${size===pageSize?' selected':''}>${size}</option>`).join('')}
            </select>
          </label>
          <button class="btn btn-ghost btn-sm" type="button" data-renewal-page="${page-1}"${page<=1?' disabled':''}>Précédent</button>
          <span aria-live="polite">Page ${page} sur ${pageCount}</span>
          <button class="btn btn-ghost btn-sm" type="button" data-renewal-page="${page+1}"${page>=pageCount?' disabled':''}>Suivant</button>
        </div>
      </div>`;
    results.querySelectorAll('[data-renewal-detail]').forEach(button=>button.addEventListener('click',()=>safe(()=>openRenewalDossier(button.dataset.renewalDetail,campaign.id))));
    results.querySelectorAll('[data-renewal-page]').forEach(button=>button.addEventListener('click',()=>{
      page=Number(button.dataset.renewalPage);
      renderRows();
    }));
    results.querySelector('[data-renewal-page-size]')?.addEventListener('change',event=>{
      pageSize=Number(event.target.value)||50;
      page=1;
      renderRows();
    });
  };
  search.addEventListener('input',()=>{page=1;renderRows();});
  statusFilter.addEventListener('change',()=>{page=1;renderRows();});
  blockFilter?.addEventListener('change',()=>{page=1;renderRows();});
  assignmentFilter.addEventListener('change',()=>{page=1;renderRows();});
  keyFilter.addEventListener('change',()=>{page=1;renderRows();});
  renderRows();
}

/* — Affectation (choix de la chambre, contrôle de capacité côté Service) — */
async function openAssignFromStudent(student){
  const snap = await snapshot();
  const opts = snap.rooms
    .filter(r => isBlockGenderCompatible(snap,student,r) && roomDerivedStatus(snap,r) !== 'complet' && r.statut !== 'hors_service')
    .sort((a,b)=>compareNames(a.bloc,b.bloc)||compareNames(a.numero,b.numero))
    .map(r => `<option value="${r.id}">${r.bloc} · ${roomLabel(r)} — ${occupantIds(snap,r.id).length}/${r.capacite} places</option>`).join('');
  if (!opts) return toast('Aucune chambre avec place disponible.','warning');
  assignModal(student, opts, 'Affecter à une chambre', student.prenom+' '+student.nom+' — choisir la chambre de destination.');
}
async function openTransfer(student){
  const snap = await snapshot();
  const opts = snap.rooms
    .filter(r => isBlockGenderCompatible(snap,student,r) && r.id !== student.chambreId && roomDerivedStatus(snap,r) !== 'complet' && r.statut !== 'hors_service')
    .sort((a,b)=>compareNames(a.bloc,b.bloc)||compareNames(a.numero,b.numero))
    .map(r => `<option value="${r.id}">${r.bloc} · ${roomLabel(r)} — ${occupantIds(snap,r.id).length}/${r.capacite} places</option>`).join('');
  if (!opts) return toast('Aucune chambre de destination disponible.','warning');
  assignModal(student, opts, 'Transférer l\u2019étudiant', 'Chambre actuelle : ' + roomLabel(snap.rooms.find(r=>r.id===student.chambreId)));
}
function assignModal(student, roomOptions, title, sub){
  Modal.open({
    title, sub,
    body:`<div class="field"><label>Chambre de destination <span class="req">*</span></label>
        <select class="inp" name="roomId" required>${roomOptions}</select></div>
      <div class="field" style="margin-top:13px"><label>Motif</label>
        <textarea class="inp" name="motif" placeholder="ex. réintégration, rapprochement…"></textarea></div>`,
    footer:`<button class="btn btn-ghost" data-mclose>Annuler</button><button class="btn btn-primary" data-ok>Confirmer l\u2019affectation</button>`,
    onMount(ov){
      ov.querySelector('[data-ok]').addEventListener('click', async e=>{
        e.preventDefault();
        await safe(async ()=>{
          const { roomId, motif } = Object.fromEntries(new FormData(ov.querySelector('form')).entries());
          const res = await Services.assign(student.id, roomId, motif.trim());
          toast(res.type==='transfert' ? 'Transfert effectué.' : 'Étudiant affecté.', 'success');
          Modal.close(); await refresh();
        });
      });
    }
  });
}
async function openTransferToBlock(student, bloc){
  const snap = await snapshot();
  const opts = snap.rooms
    .filter(r => isBlockGenderCompatible(snap,student,r) && r.bloc===bloc && r.id !== student.chambreId && roomDerivedStatus(snap,r) !== 'complet' && r.statut !== 'hors_service')
    .map(r => `<option value="${r.id}">${roomLabel(r)} — ${occupantIds(snap,r.id).length}/${r.capacite} places</option>`).join('');
  if (!opts) return toast(`Aucune chambre disponible dans ${bloc}.`,'warning');
  assignModal(student, opts, 'Transférer vers '+bloc, `Choisissez la chambre de destination dans ${bloc}.`);
}
/* — Affectation depuis une chambre (choix de l'étudiant) — */
async function openAssignFromRoom(room){
  const snap = await snapshot();
  const eligible = snap.students.filter(s => !s.chambreId&&isBlockGenderCompatible(snap,s,room));
  if (!eligible.length) return toast('Aucun étudiant en attente d\u2019affectation.','warning');
  const opts = eligible.sort((a,b)=>a.nom.localeCompare(b.nom))
    .map(s=>`<option value="${s.id}">${esc(s.nom)} ${esc(s.prenom)} — ${esc(s.matricule)}${s.statut==='sorti'?' (réintégration)':''}</option>`).join('');
  Modal.open({
    title:'Affecter un étudiant', sub:`Chambre ${roomLabel(room)} · ${room.bloc} · ${occupantIds(snap,room.id).length}/${room.capacite} occupée(s)`,
    body:`<div class="field"><label>Étudiant <span class="req">*</span></label><select class="inp" name="sid" required>${opts}</select></div>
      <div class="field" style="margin-top:13px"><label>Motif</label><textarea class="inp" name="motif"></textarea></div>`,
    footer:`<button class="btn btn-ghost" data-mclose>Annuler</button><button class="btn btn-primary" data-ok>Affecter</button>`,
    onMount(ov){
      ov.querySelector('[data-ok]').addEventListener('click', async e=>{
        e.preventDefault();
        await safe(async ()=>{
          const { sid, motif } = Object.fromEntries(new FormData(ov.querySelector('form')).entries());
          await Services.assign(sid, room.id, motif.trim());
          toast('Étudiant affecté.','success');
          Modal.close(); await refresh(); openRoom(room.id); // rouvre la fiche chambre à jour
        });
      });
    }
  });
}
/* — Libération / sortie — */
function openRelease(student){
  Modal.open({
    title:'Libération de chambre', sub:`${student.prenom} ${student.nom}`,
    body:`<p style="margin-bottom:12px">L\u2019étudiant sera marqué <b>sorti</b> et sa chambre libérée. Cette action est tracée dans l\u2019historique.</p>
      <div class="field"><label>Motif de sortie</label>
        <textarea class="inp" name="motif" placeholder="ex. fin d\u2019études, abandon, exclusion…"></textarea></div>`,
    footer:`<button class="btn btn-ghost" data-mclose>Annuler</button><button class="btn btn-danger" data-ok>${Icons.out} Confirmer la sortie</button>`,
    onMount(ov){
      ov.querySelector('[data-ok]').addEventListener('click', async e=>{
        e.preventDefault();
        await safe(async ()=>{
          const motif = new FormData(ov.querySelector('form')).get('motif');
          await Services.release(student.id, (motif||'').trim());
          toast('Chambre libérée, étudiant marqué sorti.','success');
          Modal.close(); await refresh();
        });
      });
    }
  });
}

/* ══════════════ SECTION 11 — MODULE CHAMBRES ══════════════ */
const RoomsView = { bloc:'' };
async function renderRooms(){
  const snap = await snapshot();
  const rooms = Scope.rooms(snap);
  $('tb-sub').textContent = isAdmin()
    ? `Toute la résidence · ${rooms.length} chambres au total`
    : `Périmètre : ${Session.bloc()} · ${rooms.length} chambres`;
  const savedBlocks = (snap.blocks || []).slice().sort((a,b)=>compareNames(a.name,b.name));
  const blocs = savedBlocks.length ? savedBlocks.map(b=>b.name) : [...new Set(rooms.map(r=>r.bloc))].sort(compareNames);
  if (RoomsView.bloc && !blocs.includes(RoomsView.bloc)) RoomsView.bloc = '';
  const container = $('rooms-container');
  $('room-tabs').innerHTML = `<div class="room-tab ${!RoomsView.bloc?'active':''}" data-room-tab="" role="tab">Blocs</div>` +
    blocs.map(bl=>`<div class="room-tab ${RoomsView.bloc===bl?'active':''}" data-room-tab="${esc(bl)}" role="tab">${esc(bl)}</div>`).join('') +
    (Session.user?`<button class="room-tab-add" data-action="new-block" title="Ajouter un Bloc" aria-label="Ajouter un Bloc">+</button>`:'');
  if (!RoomsView.bloc){
    const blockGroups=[
      {key:'mixte',title:'Non défini',className:'block-group-undefined'},
      {key:'fille',title:'Réservé aux filles',className:'block-group-girls'},
      {key:'garcon',title:'Réservé aux garçons',className:'block-group-boys'}
    ];
    const cardMarkup=bl=>{
      const genre=blockGender(snap,bl);
      const blockRooms=rooms.filter(r=>r.bloc===bl); const floorSet=new Set((snap.floors||[]).filter(f=>f.bloc===bl).map(f=>Number(f.numero))); blockRooms.forEach(r=>floorSet.add(floorNumber(r.numero))); const floors=floorSet.size;
      const occupants=blockRooms.reduce((sum,r)=>sum+occupantIds(snap,r.id).length,0), beds=blockRooms.reduce((sum,r)=>sum+r.capacite,0);
      const canDelete=blockRooms.every(room=>occupantIds(snap,room.id).length===0);
      return `<div class="block-card block-tone-${blocs.indexOf(bl)%6}" data-room-tab="${esc(bl)}" role="button" tabindex="0"><div class="block-card-head"><h3>${esc(bl)}</h3>${Session.user?`<span class="block-card-actions"><button class="btn-icon hov-warn" data-action="block-edit" data-bloc="${esc(bl)}" title="Modifier le Bloc">${Icons.edit}</button>${canDelete?`<button class="btn-icon hov-bad" data-action="block-del" data-bloc="${esc(bl)}" title="Supprimer le Bloc et ses chambres vides">${Icons.trash}</button>`:''}</span>`:''}</div><div class="block-card-sub">${blockGenderLabel(genre)} · Ouvrir le Bloc</div><div class="block-card-stats"><div class="block-stat"><b>${blockRooms.length}</b><span>chambres</span></div><div class="block-stat"><b>${floors}</b><span>étages</span></div><div class="block-stat"><b>${occupants}/${beds}</b><span>residents</span></div></div></div>`;
    };
    container.innerHTML = blocs.length
      ? `<div class="block-groups">${blockGroups.map(group=>{
          const groupBlocs=blocs.filter(bl=>(['fille','garcon'].includes(blockGender(snap,bl))?blockGender(snap,bl):'mixte')===group.key);
          if(!groupBlocs.length) return '';
          const groupRooms = groupBlocs.flatMap(bl => rooms.filter(r => r.bloc === bl));
          const totalRooms = groupRooms.length;
          const occupiedCount = groupRooms.reduce((sum, room) => sum + occupantIds(snap, room.id).length, 0);
          const totalBeds = groupRooms.reduce((sum, room) => sum + room.capacite, 0);
          const freePlaces = Math.max(0, totalBeds - occupiedCount);
          const roomsWithFreePlaces = groupRooms.filter(room => occupantIds(snap, room.id).length < room.capacite).length;
          const occupationRate = totalBeds ? Math.round((occupiedCount / totalBeds) * 100) : 0;
          return `<section class="block-group ${group.className}"><div class="block-group-heading"><h3>${group.title}</h3><span class="block-group-count"><span class="block-group-metric"><strong>${totalRooms}</strong> chambres</span><span class="block-group-metric"><strong>${freePlaces}</strong> places vides</span><span class="block-group-metric"><strong>${roomsWithFreePlaces}</strong> chambres avec place vide</span><span class="block-group-metric"><strong>${occupationRate}%</strong> occupation</span></span></div><div class="block-group-cards">${groupBlocs.map(cardMarkup).join('')}</div></section>`;
        }).join('')}</div>`
      : '<div class="empty">Aucun Bloc. Utilisez + pour créer le premier.</div>';
    bindRoomDnD(); return;
  }
  let list = rooms;
  if (RoomsView.bloc) list = list.filter(r=>r.bloc===RoomsView.bloc);
  if (!list.length){ container.innerHTML = '<div class="empty">Aucune chambre dans ce périmètre.</div>'; bindRoomDnD(); return; }
  const visibleBlocs = RoomsView.bloc ? [RoomsView.bloc] : blocs.filter(bl => list.some(r=>r.bloc===bl));
  container.innerHTML = visibleBlocs.map(bl => {
    const genre=blockGender(snap,bl);
    const floorNums = [...new Set(list.filter(r=>r.bloc===bl).map(r=>floorNumber(r.numero)))].sort((a,b)=>a-b);
    const floors = (snap.floors||[]).filter(f=>f.bloc===bl).map(f=>f.numero).concat(floorNums).filter((v,i,a)=>a.indexOf(v)===i).sort((a,b)=>a-b);
    const canDeleteBlock=list.filter(room=>room.bloc===bl).every(room=>occupantIds(snap,room.id).length===0);
    const blockActions = Session.user ? `<span class="block-heading-actions"><button class="btn-icon hov-brand" data-action="new-room" title="Nouvelle chambre">${Icons.plus}</button><button class="btn-icon hov-warn" data-action="new-floor" title="Nouvel étage">${Icons.bed}</button><button class="btn-icon hov-info" data-action="block-edit" data-bloc="${esc(bl)}" title="Modifier le Bloc">${Icons.edit}</button>${canDeleteBlock?`<button class="btn-icon hov-bad" data-action="block-del" data-bloc="${esc(bl)}" title="Supprimer le Bloc et ses chambres vides">${Icons.trash}</button>`:''}</span>` : '';
    const roomsInBloc = list.filter(r => r.bloc === bl);
    const freePlacesInBloc = roomsInBloc.reduce((sum, room) => sum + Math.max(0, room.capacite - occupantIds(snap, room.id).length), 0);
    const roomsWithFreePlaces = roomsInBloc.filter(room => occupantIds(snap, room.id).length < room.capacite).length;
    return `<div class="block-heading"><div class="block-heading-name" data-gender="${genre}">${esc(bl)}</div><div class="block-heading-meta">${blockGenderLabel(genre)} · <strong>${roomsInBloc.length}</strong> chambres · <strong>${freePlacesInBloc}</strong> place${freePlacesInBloc>1?'s':''} vide${freePlacesInBloc>1?'s':''} · <strong>${roomsWithFreePlaces}</strong> chambre${roomsWithFreePlaces>1?'s':''} avec place vide · <strong>${floors.length}</strong> étage${floors.length>1?'s':''}</div>${blockActions}</div>` +
    floors.map(floor => {
      const floorRooms = list.filter(r=>r.bloc===bl && floorNumber(r.numero)===floor).sort((a,b)=>compareNames(a.numero,b.numero));
      const floorCapacity = floorRooms.reduce((sum,room)=>sum+room.capacite,0);
      const floorOccupants = floorRooms.reduce((sum,room)=>sum+occupantIds(snap,room.id).length,0);
      const freePlaces = Math.max(0,floorCapacity-floorOccupants);
      const canDeleteFloor=floorRooms.every(room=>occupantIds(snap,room.id).length===0);
      const floorActions = Session.user ? `<span class="floor-actions"><button class="btn-icon hov-brand" data-action="floor-add-room" data-bloc="${esc(bl)}" data-floor="${floor}" title="Ajouter une chambre">${Icons.plus}</button><button class="btn-icon hov-warn" data-action="floor-edit" data-bloc="${esc(bl)}" data-floor="${floor}" title="Modifier l’étage">${Icons.edit}</button>${canDeleteFloor?`<button class="btn-icon hov-bad" data-action="floor-del" data-bloc="${esc(bl)}" data-floor="${floor}" title="Supprimer l’étage et ses chambres vides">${Icons.trash}</button>`:''}</span>` : '';
      if (!floorRooms.length) return `<section class="floor-group floor-tone-${floor%6}"><div class="floor-title sec-title">${floorLabel(floor)} <span style="font-size:11px;color:var(--muted);letter-spacing:0"><strong>vide</strong></span>${floorActions}</div></section>`;
      const tiles = floorRooms.map((r,i)=>{
      const occ = occupantIds(snap,r.id);
      const st = roomDerivedStatus(snap,r);
      const badge = st==='hs' ? b(['b-bad','Hors service']) : st==='complet' ? b(['b-warn','Complète']) : b(['b-ok','Disponible']);
      const names = occ.map(s=>`<span class="occupant-chip" draggable="true" data-drag-student="${s.id}" title="Glisser vers une autre chambre">${esc(s.prenom)} ${esc(s.nom)}</span>`).join('');
      return `<div class="room-tile ${st==='hs'?'hs':''}" data-action="room-open" data-drop-room="${r.id}" data-id="${r.id}" style="animation-delay:${i*0.03}s">
        ${badge}<div class="num">${roomLabel(r)}</div>
        <div class="cap">${occ.length} / ${r.capacite} resident${occ.length>1?'s':''}</div>
        <div class="dots">${Array.from({length:r.capacite},(_,k)=>`<span class="dot${k<occ.length?' on':''}"></span>`).join('')}</div>
        <div class="occupants">${names || '<span style="font-size:10.5px;color:var(--muted)">Aucun résident</span>'}</div>
      </div>`;
    }).join('');
      return `<section class="floor-group floor-tone-${floor%6}"><div class="floor-title sec-title">${floorLabel(floor)} <span style="font-size:11px;color:var(--muted);letter-spacing:0"><strong>${floorRooms.length}</strong> chambre${floorRooms.length>1?'s':''} · <strong>${freePlaces} / ${floorCapacity}</strong> places libres</span>${floorActions}</div><div class="rooms-grid">${tiles}</div></section>`;
    }).join('');
  }).join('');
  bindRoomDnD();
}
function compareNames(a,b){ return String(a).localeCompare(String(b),'fr',{numeric:true,sensitivity:'base'}); }
function floorNumber(numero){ const n=String(numero).replace(/\D/g,''); return n.length>2 ? Number(n.slice(0,-2)) : Number(n.charAt(0)) || 0; }
function floorLabel(numero){ return Number(numero)===0?'RDC':`Étage ${String(numero).padStart(2,'0')}`; }
function bindRoomDnD(){
  document.querySelectorAll('.block-card[data-room-tab]').forEach(card=>{
    card.dataset.dropBloc=card.dataset.roomTab;
    card.title='Glisser un étudiant ici pour le transférer vers ce Bloc';
    card.addEventListener('dragover',e=>{ e.preventDefault(); card.classList.add('drop-target'); });
    card.addEventListener('dragleave',()=>card.classList.remove('drop-target'));
    card.addEventListener('drop',async e=>{
      e.preventDefault(); card.classList.remove('drop-target');
      const studentId=e.dataTransfer.getData('text/student-id'); if(!studentId) return;
      await safe(async()=>{ const student=await Store.get('students',studentId); if(student) await openTransferToBlock(student,card.dataset.dropBloc); });
    });
  });
  document.querySelectorAll('.room-tab[data-room-tab]:not([data-room-tab=""])').forEach(tab=>{
    let openTimer=null;
    const clearOpenTimer=()=>{ if(openTimer){ clearTimeout(openTimer); openTimer=null; } };
    tab.title='Maintenir 3 secondes pour ouvrir ce Bloc pendant le glisser-déposer';
    tab.addEventListener('dragenter',e=>{
      e.preventDefault();
      tab.classList.add('drop-target');
      clearOpenTimer();
      if(tab.dataset.roomTab!==RoomsView.bloc) openTimer=setTimeout(async()=>{ openTimer=null; RoomsView.bloc=tab.dataset.roomTab; await renderRooms(); },3000);
    });
    tab.addEventListener('dragover',e=>{ e.preventDefault(); tab.classList.add('drop-target'); });
    tab.addEventListener('dragleave',()=>{ clearOpenTimer(); tab.classList.remove('drop-target'); });
    tab.addEventListener('drop',async e=>{
      e.preventDefault(); clearOpenTimer(); tab.classList.remove('drop-target');
      const studentId=e.dataTransfer.getData('text/student-id'); if(!studentId) return;
      await safe(async()=>{ const student=await Store.get('students',studentId); if(student) await openTransferToBlock(student,tab.dataset.roomTab); });
    });
  });
  document.querySelectorAll('[data-room-tab]').forEach(tab=>tab.addEventListener('click', async e=>{ if(e.target.closest('[data-action]')) return; RoomsView.bloc=tab.dataset.roomTab; await renderRooms(); }));
  document.querySelectorAll('[data-drag-student]').forEach(chip=>chip.addEventListener('dragstart', e=>{ e.stopPropagation(); e.dataTransfer.setData('text/student-id', chip.dataset.dragStudent); }));
  document.querySelectorAll('[data-drop-room]').forEach(tile=>{
    tile.addEventListener('dragover', e=>{ e.preventDefault(); tile.classList.add('drop-target'); });
    tile.addEventListener('dragleave', ()=>tile.classList.remove('drop-target'));
    tile.addEventListener('drop', async e=>{
      e.preventDefault(); tile.classList.remove('drop-target');
      const studentId=e.dataTransfer.getData('text/student-id'); if (!studentId) return;
      await safe(async ()=>{ await Services.assign(studentId, tile.dataset.dropRoom, 'Transfert par glisser-déposer'); toast('Transfert effectué.','success'); await refresh(); });
    });
  });
}
async function editBlock(oldName){
  const snap=await snapshot();
  const record=(snap.blocks||[]).find(b=>b.name===oldName);
  const blockRooms=snap.rooms.filter(r=>r.bloc===oldName);
  const blockFloors=(snap.floors||[]).filter(f=>f.bloc===oldName);
  const existingFloorNumbers=[...new Set(blockFloors.map(f=>f.numero).concat(blockRooms.map(r=>floorNumber(r.numero))))].sort((a,b)=>a-b);
  const existingRegularFloorNumbers=existingFloorNumbers.filter(floor=>floor>0);
  const hasGroundFloor=existingFloorNumbers.includes(0);
  const defaultRoomsPerFloor=Math.max(1,...existingRegularFloorNumbers.map(f=>blockRooms.filter(r=>floorNumber(r.numero)===f).length),10);
  const defaultCapacity=blockRooms[0]?.capacite||3;
  Modal.open({
    title:'Modifier le Bloc', sub:oldName,
    body:`<div class="fgrid">
      <div class="double">
        <div class="field"><label>Nom du Bloc <span class="req">*</span></label><input class="inp" name="name" required value="${esc(oldName)}"></div>
        <div class="field"><label>Type de Bloc</label><select class="inp" name="genre"><option value="mixte" ${(record?.genre||'mixte')==='mixte'?'selected':''}>Non défini</option><option value="fille" ${record?.genre==='fille'?'selected':''}>Réservé aux filles</option><option value="garcon" ${record?.genre==='garcon'?'selected':''}>Réservé aux garçons</option></select></div>
      </div>
      <label style="grid-column:1/-1;display:flex;align-items:center;gap:9px;text-transform:none;letter-spacing:0;font-weight:700;white-space:nowrap"><input type="checkbox" name="hasGroundFloor" value="1" style="width:16px;height:16px"${hasGroundFloor?' checked':''}> Ce bloc dispose de chambres au rez-de-chaussée (RDC)</label>
      <div class="triple">
        <div class="field"><label>Nombre d’étages</label><input class="inp" type="number" name="floorCount" min="1" max="9" value="${existingRegularFloorNumbers.length||3}"></div>
        <div class="field"><label>Chambres par étage</label><input class="inp" type="number" name="roomsPerFloor" min="1" max="99" value="${defaultRoomsPerFloor}"></div>
        <div class="field"><label>Capacité de chambres</label><input class="inp" type="number" name="capacity" min="1" max="8" value="${defaultCapacity}"></div>
      </div>
    </div><div style="margin-top:12px;font-size:11.5px;color:var(--muted)">Vous pouvez ajouter des étages. La suppression ne concerne que les étages entièrement vides.</div>`,
    footer:`<button class="btn btn-ghost" data-mclose>Annuler</button><button class="btn btn-primary" data-ok>Enregistrer</button>`,
    onMount(ov){ ov.querySelector('[data-ok]').addEventListener('click', async e=>{
      e.preventDefault(); await safe(async()=>{
        const fd=Object.fromEntries(new FormData(ov.querySelector('form')).entries()); const name=String(fd.name||'').trim(), genre=String(fd.genre||'mixte');
        const includeGroundFloor=fd.hasGroundFloor==='1';
        const roomCount=Math.max(1,Math.min(99,Number(fd.roomsPerFloor)||10));
        const capacity=Math.max(1,Math.min(8,Number(fd.capacity)||3));
        const floorCount=Number(fd.floorCount);
        if(!name) throw AppError('Le nom du Bloc est obligatoire.');
        if(!['fille','garcon','mixte'].includes(genre)) throw AppError('Choisissez un type de Bloc valide.');
        if(floorCount<1||floorCount>9||!Number.isInteger(floorCount)||!Number.isInteger(Number(fd.roomsPerFloor))||Number(fd.roomsPerFloor)<1||Number(fd.roomsPerFloor)>99) throw AppError('Vérifiez le nombre d’étages et de chambres.');
        if(!includeGroundFloor&&hasGroundFloor&&blockRooms.some(room=>floorNumber(room.numero)===0)) throw AppError('Impossible de retirer le RDC : il contient encore des chambres.');
        const floorsToRemove=floorCount<existingRegularFloorNumbers.length
          ? existingRegularFloorNumbers.slice().sort((a,b)=>b-a).filter(floor=>!blockRooms.some(room=>floorNumber(room.numero)===floor)).slice(0,existingRegularFloorNumbers.length-floorCount)
          : [];
        if(floorCount<existingRegularFloorNumbers.length&&floorsToRemove.length<existingRegularFloorNumbers.length-floorCount) throw AppError('Impossible de réduire ce Bloc : seuls les étages entièrement vides peuvent être supprimés.');
        if(includeGroundFloor&&!hasGroundFloor){
          const groundRoomNumbers=Array.from({length:roomCount},(_,index)=>String(index+1).padStart(3,'0'));
          if(groundRoomNumbers.some(numero=>blockRooms.some(room=>room.numero===numero))) throw AppError('Une ou plusieurs chambres prévues au RDC existent déjà.');
        }
        if(name.toLowerCase()!==oldName.toLowerCase()&&(snap.blocks||[]).some(b=>b.name.toLowerCase()===name.toLowerCase())) throw AppError('Ce Bloc existe déjà.');
        if(genre!=='mixte'){
          const incompatible=snap.students.find(student=>{
            const room=blockRooms.find(item=>item.id===student.chambreId);
            return room&&student.statut==='actif'&&residentGender(student.sexe)!==genre;
          });
          if(incompatible) throw AppError(`Impossible de réserver ce Bloc aux ${blockGenderLabel(genre).toLowerCase()} : ${incompatible.prenom} ${incompatible.nom} ne correspond pas à cette catégorie.`);
        }
        if(record) await Store.update('blocks',record.id,{name,genre});
        else await Store.insert('blocks',{id:uid(),name,genre,ordre:(snap.blocks||[]).length});
        for(const r of snap.rooms.filter(r=>r.bloc===oldName)) await Store.update('rooms',r.id,{bloc:name});
        for(const f of (snap.floors||[]).filter(f=>f.bloc===oldName)) await Store.update('floors',f.id,{bloc:name});
        for(const h of snap.history.filter(h=>h.bloc===oldName)){ const room=snap.rooms.find(r=>r.id===h.roomId); await Store.update('history',h.id,{bloc:name,roomLabel:room?`${name}-${room.numero}`:h.roomLabel}); }
        for(const c of snap.complaints.filter(c=>c.bloc===oldName)){ const room=snap.rooms.find(r=>r.id===c.roomId); await Store.update('complaints',c.id,{bloc:name,roomLabel:room?`${name}-${room.numero}`:c.roomLabel}); }
        for(const u of snap.users.filter(u=>u.bloc===oldName)) await Store.update('users',u.id,{bloc:name});
        if(!existingRegularFloorNumbers.length){ await createBlockStructure(name,floorCount,roomCount,capacity,snap,false,genre); }
        else if(floorCount>existingRegularFloorNumbers.length){
          const available=Array.from({length:9},(_,i)=>i+1).filter(n=>!existingFloorNumbers.includes(n));
          for(const floorNo of available.slice(0,floorCount-existingRegularFloorNumbers.length)){ await Store.insert('floors',{id:uid(),bloc:name,numero:floorNo}); for(let roomNo=1;roomNo<=roomCount;roomNo++) await Store.insert('rooms',{id:uid(),bloc:name,numero:String(floorNo*100+roomNo).padStart(3,'0'),capacite:capacity,statut:'normal'}); }
        } else if(floorCount<existingRegularFloorNumbers.length){
          for(const floorNo of floorsToRemove){ const floorRecord=blockFloors.find(f=>f.numero===floorNo); if(floorRecord) await Store.remove('floors',floorRecord.id); }
        }
        if(includeGroundFloor&&!hasGroundFloor){
          const groundRoomNumbers=Array.from({length:roomCount},(_,index)=>String(index+1).padStart(3,'0'));
          await Store.insert('floors',{id:uid(),bloc:name,numero:0});
          for(const numero of groundRoomNumbers) await Store.insert('rooms',{id:uid(),bloc:name,numero,capacite:capacity,statut:'normal'});
        } else if(!includeGroundFloor&&hasGroundFloor){
          const groundRecord=blockFloors.find(floor=>floor.numero===0);
          if(groundRecord) await Store.remove('floors',groundRecord.id);
        }
        RoomsView.bloc=RoomsView.bloc===oldName?name:RoomsView.bloc; Modal.close(); toast('Bloc modifié.','success'); await refresh();
      });
    }); }
  });
}
async function deleteBlock(name){
  const snap=await snapshot(); const rooms=snap.rooms.filter(r=>r.bloc===name);
  if(snap.users.some(user=>user.bloc===name)) return toast('Impossible de supprimer ce Bloc : des utilisateurs y sont rattachés.','warning');
  const reason=roomRemovalBlocker(snap,rooms);
  if(reason) return toast(`Impossible de supprimer ce Bloc : ${reason}`,'warning');
  if(!(await confirmDialog({title:'Supprimer le Bloc',danger:true,ok:'Supprimer',message:`Supprimer définitivement le Bloc <b>${esc(name)}</b> ainsi que ses ${rooms.length} chambre${rooms.length===1?' vide':'s vides'} ?`}))) return;
  await safe(async()=>{
    const latest=await snapshot(), latestRooms=latest.rooms.filter(room=>room.bloc===name);
    if(latest.users.some(user=>user.bloc===name)) throw AppError('Impossible de supprimer ce Bloc : des utilisateurs y sont rattachés.');
    const latestReason=roomRemovalBlocker(latest,latestRooms);
    if(latestReason) throw AppError(`Impossible de supprimer ce Bloc : ${latestReason}`);
    for(const room of latestRooms) await Store.remove('rooms',room.id);
    for(const floor of (latest.floors||[]).filter(floor=>floor.bloc===name)) await Store.remove('floors',floor.id);
    const record=(latest.blocks||[]).find(block=>block.name===name);
    if(record) await Store.remove('blocks',record.id);
    RoomsView.bloc=''; toast('Bloc et chambres vides supprimés.','success'); await refresh();
  });
}
function roomRemovalBlocker(snap,rooms){
  const occupied=rooms.find(room=>occupantIds(snap,room.id).length);
  if(occupied) return `la chambre ${roomLabel(occupied)} contient encore un résident.`;
  const referenced=rooms.find(room=>snap.history.some(item=>item.roomId===room.id)||snap.complaints.some(item=>item.roomId===room.id));
  if(referenced) return `la chambre ${roomLabel(referenced)} est référencée dans l’historique ou une réclamation.`;
  return '';
}
async function createBlockStructure(name, floorCount, roomsPerFloor, capacity, snap, insertBlock=true, genre='mixte', hasGroundFloor=false){
  if(insertBlock) await Store.insert('blocks',{id:uid(),name,genre,ordre:(snap.blocks||[]).length});
  if(hasGroundFloor){
    await Store.insert('floors',{id:uid(),bloc:name,numero:0});
    for(let room=1;room<=roomsPerFloor;room++) await Store.insert('rooms',{id:uid(),bloc:name,numero:String(room).padStart(3,'0'),capacite:capacity,statut:'normal'});
  }
  for(let floor=1; floor<=floorCount; floor++){
    await Store.insert('floors',{id:uid(),bloc:name,numero:floor});
    for(let room=1; room<=roomsPerFloor; room++) await Store.insert('rooms',{id:uid(),bloc:name,numero:String(floor*100+room).padStart(3,'0'),capacite:capacity,statut:'normal'});
  }
}
async function openBlockForm(){
  const snap=await snapshot();
  Modal.open({ title:'Nouveau Bloc', sub:'Créer un Bloc avec ses étages et ses chambres', body:`<div class="fgrid">
    <div class="double">
      <div class="field"><label>Nom du Bloc <span class="req">*</span></label><input class="inp" name="name" required placeholder="ex. Bloc D"></div>
      <div class="field"><label>Type de Bloc</label><select class="inp" name="genre"><option value="mixte" selected>Non défini</option><option value="fille">Réservé aux filles</option><option value="garcon">Réservé aux garçons</option></select></div>
    </div>
    <label style="grid-column:1/-1;display:flex;align-items:center;gap:9px;text-transform:none;letter-spacing:0;font-weight:700;white-space:nowrap"><input type="checkbox" name="hasGroundFloor" value="1" style="width:16px;height:16px"> Ce bloc dispose de chambres au rez-de-chaussée (RDC)</label>
    <div class="triple">
      <div class="field"><label>Nombre d’étages <span class="req">*</span></label><input class="inp" type="number" name="floorCount" min="1" max="9" required value="3"></div>
      <div class="field"><label>Chambres par étage <span class="req">*</span></label><input class="inp" type="number" name="roomsPerFloor" min="1" max="99" required value="10"></div>
      <div class="field"><label>Capacité de chambres <span class="req">*</span></label><input class="inp" type="number" name="capacity" min="1" max="8" required value="3"></div>
    </div>
  </div><div style="margin-top:12px;font-size:11.5px;color:var(--muted)">Exemple : 3 étages × 10 chambres crée les chambres 101–110, 201–210 et 301–310. Le RDC, s’il est sélectionné, crée les chambres 001–010.</div>`, footer:`<button class="btn btn-ghost" data-mclose>Annuler</button><button class="btn btn-primary" data-ok>Créer le Bloc</button>`, onMount(ov){ ov.querySelector('[data-ok]').addEventListener('click', async e=>{ e.preventDefault(); await safe(async()=>{ const fd=Object.fromEntries(new FormData(ov.querySelector('form')).entries()); const name=String(fd.name||'').trim(), genre=String(fd.genre||'mixte'), floorCount=Number(fd.floorCount), roomsPerFloor=Number(fd.roomsPerFloor), capacity=Math.max(1,Math.min(8,Number(fd.capacity)||3)); if(!name) throw AppError('Le nom du Bloc est obligatoire.'); if(!['fille','garcon','mixte'].includes(genre)) throw AppError('Choisissez un type de Bloc valide.'); if((snap.blocks||[]).some(b=>b.name.toLowerCase()===name.toLowerCase())) throw AppError('Ce Bloc existe déjà.'); if(floorCount<1||floorCount>9||roomsPerFloor<1||roomsPerFloor>99) throw AppError('Vérifiez le nombre d’étages et de chambres.'); await createBlockStructure(name,floorCount,roomsPerFloor,capacity,snap,true,genre,fd.hasGroundFloor==='1'); Modal.close(); RoomsView.bloc=name; toast(`Bloc ${name} créé avec ${floorCount} étages${fd.hasGroundFloor==='1'?' et un RDC':''}.`,'success'); await refresh(); }); }); } });
}
function nextRoomNumber(rooms, bloc, floor){
  let n=1;
  while(rooms.some(r=>r.bloc===bloc&&r.numero===String(Number(floor)*100+n).padStart(3,'0'))) n++;
  return String(Number(floor)*100+n).padStart(3,'0');
}
async function addRoomToFloor(bloc, numero){
  const snap=await snapshot();
  const floorRooms=snap.rooms.filter(r=>r.bloc===bloc&&floorNumber(r.numero)===Number(numero));
  if(floorRooms.length>=99) return toast('Cet étage a atteint la limite de 99 chambres.','warning');
  const numeroRoom=nextRoomNumber(snap.rooms,bloc,numero);
  const capacity=floorRooms[0]?.capacite||3;
  await safe(async()=>{ await Store.insert('rooms',{id:uid(),bloc,numero:numeroRoom,capacite:capacity,statut:'normal'}); toast(`Chambre ${bloc}-${numeroRoom} ajoutée.`,'success'); await refresh(); });
}
async function editFloor(bloc, numero){
  const snap=await snapshot();
  const floor=(snap.floors||[]).find(f=>f.bloc===bloc&&f.numero===Number(numero));
  if(!floor) return toast('Étage introuvable.','error');
  const rooms=snap.rooms.filter(r=>r.bloc===bloc&&floorNumber(r.numero)===Number(numero));
  const defaultCapacity=rooms[0]?.capacite||3;
  Modal.open({
    title:'Modifier l’étage', sub:`${bloc} · ${floorLabel(numero)}`,
    body:`<div class="fgrid">
      <div class="field"><label>Nombre de chambres <span class="req">*</span></label><input class="inp" type="number" name="roomCount" min="0" max="99" required value="${rooms.length}"></div>
      <div class="field"><label>Capacité de toutes les chambres</label><input class="inp" type="number" name="capacite" min="1" max="8" required value="${defaultCapacity}"></div>
    </div><div style="margin-top:10px;font-size:11.5px;color:var(--muted)">${floorLabel(numero)} · La capacité choisie sera appliquée aux chambres existantes, même occupées, ainsi qu’aux nouvelles chambres. Une chambre occupée ou référencée ne sera jamais supprimée.</div>`,
    footer:`<button class="btn btn-ghost" data-mclose>Annuler</button><button class="btn btn-primary" data-ok>Enregistrer</button>`,
    onMount(ov){ ov.querySelector('[data-ok]').addEventListener('click', async e=>{ e.preventDefault(); await safe(async()=>{
      const fd=Object.fromEntries(new FormData(ov.querySelector('form')).entries()); const target=Number(fd.roomCount),capacity=Number(fd.capacite);
      if(target<0||target>99||!Number.isInteger(target)) throw AppError('Le nombre de chambres doit être compris entre 0 et 99.');
      if(!Number.isInteger(capacity)||capacity<1||capacity>8) throw AppError('La capacité de chaque chambre doit être comprise entre 1 et 8.');
      let removeRooms=[];
      if(target<rooms.length){
        const removeCandidates=rooms.slice().sort((a,b)=>b.numero.localeCompare(a.numero)).filter(r=>!snap.students.some(s=>s.chambreId===r.id)&&!snap.history.some(h=>h.roomId===r.id)&&!snap.complaints.some(c=>c.roomId===r.id));
        const toRemove=rooms.length-target;
        if(removeCandidates.length<toRemove) throw AppError('Impossible de réduire cet étage : certaines chambres sont occupées ou référencées dans l’historique.');
        removeRooms=removeCandidates.slice(0,toRemove);
      }
      const retainedRooms=rooms.filter(room=>!removeRooms.some(remove=>remove.id===room.id));
      const overCapacity=retainedRooms.map(room=>({room,occupants:snap.students.filter(student=>student.chambreId===room.id&&student.statut==='actif').length})).find(({occupants})=>occupants>capacity);
      if(overCapacity) throw AppError(`Impossible d’appliquer une capacité de ${capacity} à toutes les chambres : ${roomLabel(overCapacity.room)} compte déjà ${overCapacity.occupants} résidents actifs.`);
      for(const room of removeRooms) await Store.remove('rooms',room.id);
      for(const room of retainedRooms) if(room.capacite!==capacity) await Store.update('rooms',room.id,{capacite:capacity});
      if(target>rooms.length){ for(let i=rooms.length;i<target;i++) await Store.insert('rooms',{id:uid(),bloc,numero:nextRoomNumber(await Store.list('rooms'),bloc,numero),capacite:capacity,statut:'normal'}); }
      Modal.close(); toast('Chambres et capacités de l’étage mises à jour.','success'); await refresh();
    }); }); }
  });
}
async function deleteFloor(bloc, numero){
  const snap=await snapshot();
  const floor=(snap.floors||[]).find(f=>f.bloc===bloc&&f.numero===Number(numero));
  const rooms=snap.rooms.filter(room=>room.bloc===bloc&&floorNumber(room.numero)===Number(numero));
  if(!floor&&!rooms.length) return toast('Étage introuvable.','error');
  const reason=roomRemovalBlocker(snap,rooms);
  if(reason) return toast(`Impossible de supprimer ${floorLabel(numero)} : ${reason}`,'warning');
  if(!(await confirmDialog({title:'Supprimer l’étage',danger:true,ok:'Supprimer',message:`Supprimer définitivement ${floorLabel(numero)} du Bloc <b>${esc(bloc)}</b> ainsi que ses ${rooms.length} chambre${rooms.length===1?' vide':'s vides'} ?`}))) return;
  await safe(async()=>{
    const latest=await snapshot();
    const latestRooms=latest.rooms.filter(room=>room.bloc===bloc&&floorNumber(room.numero)===Number(numero));
    const latestReason=roomRemovalBlocker(latest,latestRooms);
    if(latestReason) throw AppError(`Impossible de supprimer ${floorLabel(numero)} : ${latestReason}`);
    for(const room of latestRooms) await Store.remove('rooms',room.id);
    const latestFloor=(latest.floors||[]).find(item=>item.bloc===bloc&&item.numero===Number(numero));
    if(latestFloor) await Store.remove('floors',latestFloor.id);
    toast(`${floorLabel(numero)} et ses chambres vides supprimés.`,'success'); await refresh();
  });
}
async function openFloorForm(presetBloc=RoomsView.bloc){
  const snap=await snapshot(); const blocs=(snap.blocks||[]).map(b=>b.name).concat([...new Set(snap.rooms.map(r=>r.bloc))]).filter((v,i,a)=>a.indexOf(v)===i).sort();
  const usedFloors=(snap.floors||[]).filter(f=>f.bloc===presetBloc).map(f=>Number(f.numero)).concat(snap.rooms.filter(r=>r.bloc===presetBloc).map(r=>floorNumber(r.numero)));
  const suggestedFloor=Array.from({length:9},(_,i)=>i+1).find(n=>!usedFloors.includes(n)) || 1;
  Modal.open({
    title:'Nouvel étage', sub:'Créer les chambres automatiquement selon le code de l’étage',
    body:`<div class="fgrid">
      <div class="field"><label>Bloc</label><select class="inp" name="bloc">${blocs.map(b=>`<option ${b===presetBloc?'selected':''}>${esc(b)}</option>`).join('')}</select></div>
      <div class="field"><label>Étage</label><input class="inp" type="number" name="numero" min="1" max="9" required value="${suggestedFloor}" placeholder="ex. 04"></div>
      <div class="field"><label>Nombre de chambres <span class="req">*</span></label><input class="inp" type="number" name="roomCount" min="1" max="99" required value="10"></div>
      <div class="field"><label>Capacité par chambre</label><input class="inp" type="number" name="capacite" min="1" max="8" required value="3"></div>
    </div>
    <div style="margin-top:12px;font-size:11.5px;color:var(--muted)">Exemple : étage 03 avec 5 chambres → 301, 302, 303, 304 et 305.</div>`,
    footer:`<button class="btn btn-ghost" data-mclose>Annuler</button><button class="btn btn-primary" data-ok>Créer l’étage et les chambres</button>`,
    onMount(ov){ ov.querySelector('[data-ok]').addEventListener('click', async e=>{
      e.preventDefault();
      await safe(async()=>{
        const fd=Object.fromEntries(new FormData(ov.querySelector('form')).entries());
        const numero=Number(fd.numero), roomCount=Number(fd.roomCount), capacite=Math.max(1,Math.min(8,Number(fd.capacite)||3));
        if(!numero || numero<1 || numero>9) throw AppError('L’étage doit être compris entre 01 et 09.');
        if(!roomCount || roomCount<1 || roomCount>99) throw AppError('Le nombre de chambres doit être compris entre 1 et 99.');
        if((snap.floors||[]).some(f=>f.bloc===fd.bloc&&f.numero===numero)) throw AppError('Cet étage existe déjà.');
        const roomNumbers=Array.from({length:roomCount},(_,i)=>String(numero*100+i+1).padStart(3,'0'));
        if(roomNumbers.some(n=>snap.rooms.some(r=>r.bloc===fd.bloc&&r.numero===n))) throw AppError('Une ou plusieurs chambres de cet étage existent déjà.');
        await Store.insert('floors',{id:uid(),bloc:fd.bloc,numero});
        for(const roomNumber of roomNumbers) await Store.insert('rooms',{id:uid(),bloc:fd.bloc,numero:roomNumber,capacite,statut:'normal'});
        Modal.close(); RoomsView.bloc=fd.bloc; toast(`${roomCount} chambres créées pour ${floorLabel(numero)}.`,'success'); await refresh();
      });
    }); }
  });
}
/* — Fiche chambre — */
async function openRoom(id){
  const snap = await snapshot();
  const r = snap.rooms.find(x=>x.id===id);
  if (!r) return toast('Chambre introuvable.','error');
  requireBloc(r.bloc);
  const occ = occupantIds(snap,r.id);
  const st = roomDerivedStatus(snap,r);
  const hist = snap.history.filter(h=>h.roomId===r.id).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,8);
  const admin = isAdmin();
  Modal.open({
    title:'Fiche chambre', sub:`${roomLabel(r)} · ${r.bloc}`, wide:true,
    body:`<div style="display:flex;gap:10px;align-items:center;margin-bottom:14px">
        <div style="font-family:var(--font-display);font-size:26px;font-weight:800">${roomLabel(r)}</div>
        ${st==='hs'?b(['b-bad','Hors service']):st==='complet'?b(['b-warn','Complète']):b(['b-ok','Disponible'])}
        <span class="badge b-neutral">Capacité ${r.capacite}</span></div>
      <div class="sec-title">Résidents (${occ.length}/${r.capacite})</div>
      ${occ.length ? `<ul class="list-plain">` + occ.map(s=>
        `<li><span class="badge b-info">${esc(s.matricule)}</span><span class="grow">${esc(s.nom)} ${esc(s.prenom)} · ${esc(s.faculte)}</span>
         <button class="btn-icon hov-info" data-room-student="${esc(s.id)}" title="Fiche">${Icons.eye}</button>
         ${admin?`<button class="btn-icon hov-warn" data-rel="${s.id}" title="Libérer ce résident">${Icons.out}</button>`:''}</li>`).join('') + '</ul>'
        : '<div class="empty" style="padding:14px">Chambre vide.</div>'}
      <div class="sec-title">Derniers mouvements</div>
      ${hist.length ? `<ul class="list-plain">` + hist.map(h=>
        `<li>${b(BLOC_BADGE[h.type])}<span class="grow">${esc(h.studentName)} — ${esc(h.motif)}</span><span class="sub" style="color:var(--muted);font-size:11.5px">${fmtDate(h.date)}</span></li>`).join('') + '</ul>'
        : '<div class="empty" style="padding:14px">Aucun mouvement.</div>'}`,
    footer: (admin ? `
      ${st!=='complet' && st!=='hs' ? `<button class="btn btn-primary" data-act="assign">${Icons.bed} Affecter un étudiant</button>` : ''}
      <button class="btn btn-warning" style="margin-right:auto" data-act="hs">${st==='hs'?Icons.check:Icons.alert} ${st==='hs'?'Remettre en service':'Mettre hors service'}</button>
      <button class="btn btn-ghost" data-act="edit">${Icons.edit} Modifier</button>
      ${occ.length===0?`<button class="btn btn-danger" data-act="del">${Icons.trash} Supprimer</button>`:''}` : '') +
      `<button class="btn btn-ghost" data-mclose>Fermer</button>`,
    onMount(ov){
      const bind = (sel,fn)=>{ const el = ov.querySelector(sel); if (el) el.addEventListener('click', fn); };
      const modalBody=ov.querySelector('.m-body'),modalFooter=ov.querySelector('.m-foot');
      const roomContent=document.createDocumentFragment();
      let roomFooter=null,inStudentFiche=false,roomScrollTop=0;
      const heading=ov.querySelector('.m-head h3'),subtitle=ov.querySelector('.m-sub');
      const roomTitle=heading?.textContent||'',roomSub=subtitle?.textContent||'';
      const openEmbeddedStudentFiche=studentId=>{
        if(!inStudentFiche){
          roomScrollTop=modalBody.scrollTop;
          while(modalBody.firstChild) roomContent.append(modalBody.firstChild);
          roomFooter=modalFooter?document.createDocumentFragment():null;
          if(modalFooter) while(modalFooter.firstChild) roomFooter.append(modalFooter.firstChild);
          inStudentFiche=true;
        }
        currentStudentFicheId=studentId;
        if(heading) heading.textContent='Fiche étudiant';
        if(subtitle) subtitle.textContent='';
        if(modalFooter) modalFooter.hidden=true;
        safe(()=>renderStudentFichePage(modalBody,{embedded:true,onBack:()=>{
          modalBody.replaceChildren(roomContent);
          modalBody.scrollTop=roomScrollTop;
          if(heading) heading.textContent=roomTitle;
          if(subtitle) subtitle.textContent=roomSub;
          if(modalFooter){
            modalFooter.replaceChildren(roomFooter);
            modalFooter.hidden=false;
          }
          inStudentFiche=false;
        }}));
      };
      ov.querySelectorAll('[data-room-student]').forEach(button=>button.addEventListener('click',()=>openEmbeddedStudentFiche(button.dataset.roomStudent)));
      ov.querySelectorAll('[data-rel]').forEach(bt => bt.addEventListener('click', async ()=>{
        const s = snap.students.find(x=>x.id===bt.dataset.rel);
        Modal.close(); openRelease(s);
      }));
      bind('[data-act="assign"]', ()=>{ Modal.close(); openAssignFromRoom(r); });
      bind('[data-act="edit"]', ()=>{ Modal.close(); openRoomForm(r); });
      bind('[data-act="hs"]', async ()=>{
        Modal.close();
        const toHS = r.statut !== 'hors_service';
        if (toHS && occ.length){
          toast(`Impossible : ${occ.length} résident(s) sont encore affecté(s) à cette chambre. Transférez-les ou libérez la chambre avant sa mise hors service.`, 'warning');
          return;
        }
        await safe(async ()=>{
          await Store.update('rooms', r.id, { statut: toHS?'hors_service':'normal' });
          toast(toHS?'Chambre mise hors service.':'Chambre remise en service.','success');
          await refresh();
        });
      });
      bind('[data-act="del"]', async ()=>{
        Modal.close();
        if (!(await confirmDialog({ title:'Supprimer la chambre', danger:true, ok:'Supprimer',
          message:`Supprimer définitivement la chambre <b>${roomLabel(r)}</b> ?` }))) return;
        await safe(async ()=>{
          const latest = await snapshot();
          if (latest.history.some(h=>h.roomId===r.id) || latest.complaints.some(c=>c.roomId===r.id))
            throw AppError('Impossible de supprimer cette chambre : elle possède déjà un historique ou des réclamations.');
          await Store.remove('rooms', r.id);
          toast('Chambre supprimée.','success'); await refresh();
        });
      });
    }
  });
}
/* — Formulaire chambre — */
async function openRoomForm(room, preset={}){
  const snap = await snapshot();
  const blocs = (snap.blocks||[]).map(b=>b.name).concat([...new Set(snap.rooms.map(r=>r.bloc))]).filter((v,i,a)=>a.indexOf(v)===i).sort();
  const hasPresetFloor=preset.floor!==undefined&&preset.floor!==null&&preset.floor!=='';
  let suggestedNumero = '';
  if (hasPresetFloor) suggestedNumero=nextRoomNumber(snap.rooms,preset.bloc,Number(preset.floor));
  const r = room || { statut:'normal', capacite:2, bloc:preset.bloc || RoomsView.bloc || blocs[0], numero:suggestedNumero };
  Modal.open({
    title: room ? 'Modifier la chambre' : 'Nouvelle chambre',
    sub: room ? roomLabel(room)+' · '+room.bloc : 'Ajout au parc de la résidence',
    body:`<div class="fgrid">
      <div class="field"><label>Bloc <span class="req">*</span></label>
        <select class="inp" name="bloc" id="rmf-bloc">
          ${blocs.map(bl=>`<option ${r.bloc===bl?'selected':''}>${bl}</option>`).join('')}
          <option value="__new">➕ Nouveau bloc…</option>
        </select></div>
      <div class="field" id="rmf-newwrap" hidden><label>Nom du nouveau bloc</label>
        <input class="inp" name="newBloc" placeholder="ex. Bloc D"></div>
      <div class="field"><label>Numéro <span class="req">*</span></label><input class="inp" name="numero" required value="${esc(r.numero)}" placeholder="ex. 204"></div>
      <div class="field"><label>Capacité <span class="req">*</span></label><input class="inp" type="number" name="capacite" min="1" required value="${r.capacite}"></div>
      <div class="field"><label>État</label><select class="inp" name="statut">
        <option value="normal" ${r.statut==='normal'?'selected':''}>En service</option>
        <option value="hors_service" ${r.statut==='hors_service'?'selected':''}>Hors service</option></select></div>
    </div>`,
    footer:`<button class="btn btn-ghost" data-mclose>Annuler</button><button class="btn btn-primary" data-ok>${room?'Enregistrer':'Créer la chambre'}</button>`,
    onMount(ov){
      const selB = ov.querySelector('#rmf-bloc'), nw = ov.querySelector('#rmf-newwrap');
      selB.addEventListener('change', ()=>{ nw.hidden = selB.value !== '__new'; });
      ov.querySelector('[data-ok]').addEventListener('click', async e=>{
        e.preventDefault();
        await safe(async ()=>{
          const fd = Object.fromEntries(new FormData(ov.querySelector('form')).entries());
          const bloc = fd.bloc === '__new' ? (fd.newBloc||'').trim() : fd.bloc;
          if (!bloc || !fd.numero.trim()) throw AppError('Bloc et numéro sont obligatoires.');
          const capacite = Math.max(1, Math.floor(+fd.capacite || 1));
          const numero = fd.numero.trim();
          if (!/^\d{3}$/.test(numero)) throw AppError('Le numéro doit contenir 3 chiffres : 101, 201, 305…');
          const duplicate = snap.rooms.find(x => x.id !== (room?.id || '') &&
            x.bloc === bloc && x.numero.toLowerCase() === numero.toLowerCase());
          if (duplicate) throw AppError(`La chambre ${roomLabel(duplicate)} existe déjà dans ${bloc}.`);
          if (room){
            const occN = occupantIds(snap, room.id).length;
            if (capacite < occN) throw AppError(`Impossible : ${occN} résident(s) pour une capacité de ${capacite}.`);
            const identityChanged = room.bloc !== bloc || room.numero !== numero;
            const referenced = snap.history.some(h=>h.roomId===room.id) || snap.complaints.some(c=>c.roomId===room.id);
            if (identityChanged && referenced)
              throw AppError('Le bloc ou le numéro ne peut pas être modifié : cette chambre possède déjà un historique ou des réclamations.');
            await Store.update('rooms', room.id, { bloc, numero, capacite, statut: fd.statut });
            toast('Chambre mise à jour.','success');
          } else {
            await Store.insert('rooms', { id:uid(), bloc, numero, capacite, statut: fd.statut });
            if (!(snap.blocks||[]).some(b=>b.name===bloc)) await Store.insert('blocks', { id:uid(), name:bloc, genre:'mixte', ordre:(snap.blocks||[]).length });
            const floor = floorNumber(numero);
            if (!(snap.floors||[]).some(f=>f.bloc===bloc && f.numero===floor)) await Store.insert('floors', { id:uid(), bloc, numero:floor });
            toast('Chambre créée.','success');
          }
          Modal.close(); await refresh();
        });
      });
    }
  });
}

/* ══════════════ SECTION 12 — MODULE RÉCLAMATIONS & MAINTENANCE ══════════════ */
const RecView = { statut:'', prio:'', type:'', bloc:'' };
async function renderComplaints(){
  const snap = await snapshot();
  $('rc-statut').innerHTML = '<option value="">Statut : tous</option>' + REC_STATUTS.map(([v,l])=>`<option value="${v}">${l}</option>`).join('');
  $('rc-prio').innerHTML = '<option value="">Priorité : toutes</option>' + PRIORITES.map(([v,l])=>`<option value="${v}">${l}</option>`).join('');
  $('rc-type').innerHTML = '<option value="">Type : tous</option>' + TYPES_REC.map(([v,l])=>`<option value="${v}">${l}</option>`).join('');
  const blocs = [...new Set(snap.rooms.map(r=>r.bloc))];
  $('rc-bloc').parentElement; // no-op
  $('rc-bloc').innerHTML = '<option value="">Bloc : tous</option>' + blocs.map(bl=>`<option ${RecView.bloc===bl?'selected':''}>${bl}</option>`).join('');
  if (!isAdmin()){ $('rc-bloc').value = Session.bloc(); $('rc-bloc').disabled = true; } else $('rc-bloc').disabled = false;
  Object.assign(RecView, {}); $('rc-statut').value=RecView.statut; $('rc-prio').value=RecView.prio; $('rc-type').value=RecView.type;
  $('rc-scopenote').innerHTML = isAdmin() ? '' :
    `<div class="scope-note">Périmètre agent : réclamations du ${Session.bloc()} uniquement.</div>`;
  await renderComplaintsTable();
}
async function renderComplaintsTable(){
  const snap = await snapshot();
  let list = Scope.complaints(snap);
  const f = RecView;
  if (f.statut) list = list.filter(c=>c.statut===f.statut);
  if (f.prio) list = list.filter(c=>c.priorite===f.prio);
  if (f.type) list = list.filter(c=>c.type===f.type);
  if (!isAdmin() || f.bloc) list = list.filter(c=>c.bloc===(isAdmin()?f.bloc:Session.bloc()));
  const prio = { haute:0, moyenne:1, basse:2 };
  list.sort((a,b)=> b.declaredAt.localeCompare(a.declaredAt));
  $('rc-count').textContent = `${list.length} réclamation${list.length>1?'s':''} affichée${list.length>1?'s':''}`;
  $('tb-sub').textContent = `${Scope.complaints(snap).filter(c=>c.statut==='nouvelle'||c.statut==='en_cours').length} ouverte(s) sur ${Scope.complaints(snap).length}`;
  $('rc-tbody').innerHTML = list.length ? list.map(c=>{
    const editOk = isAdmin() || c.bloc === Session.bloc();
    return `<tr>
      <td class="mono">#${esc(c.id.slice(0,4).toUpperCase())}</td>
      <td><span class="badge b-info">${esc(c.roomLabel)}</span><div style="font-size:11px;color:var(--muted);margin-top:2px">${esc(c.bloc)}</div></td>
      <td>${(TYPES_REC.find(t=>t[0]===c.type)||['','Inconnu'])[1]}</td>
      <td style="max-width:250px"><div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(c.description)}">${esc(c.description)}</div>
        <div style="font-size:11px;color:var(--muted)">${fmtDate(c.declaredAt)}</div></td>
      <td>${b(PRIO_BADGE[c.priorite])}</td>
      <td class="name"><b style="font-weight:600">${esc(c.declaredByName)}</b><span>${c.declaredByType==='agent'?'Agent':'Étudiant(e)'}</span></td>
      <td>${b(REC_STATUT_BADGE[c.statut])}</td>
      <td class="actions"></td></tr>`;
  }).join('') : `<tr><td colspan="8"><div class="empty">Aucune réclamation ne correspond aux filtres.</div></td></tr>`;
}
/* — Formulaire réclamation (création / édition) — */
async function openComplaintForm(rec){
  const snap = await snapshot();
  const rooms = Scope.rooms(snap).filter(r=>r.statut!=='hors_service' || rec);
  const agents = (await Store.list('users')).filter(u=>u.active);
  const isEdit = !!rec;
  const c = rec || { priorite:'moyenne', type:'plomberie', declaredByType:'agent' };
  const roomOpts = rooms.map(r=>`<option value="${r.id}" ${c.roomId===r.id?'selected':''}>${roomLabel(r)} · ${r.bloc}</option>`).join('');
  const occupantsOpts = c.roomId
    ? occupantIds(snap,c.roomId).map(s=>`<option value="${s.id}" ${c.declaredByName===s.nom+' '+s.prenom?'selected':''}>${esc(s.nom)} ${esc(s.prenom)}</option>`).join('')
    : '';
  Modal.open({
    title: isEdit?'Modifier la réclamation':'Nouvelle réclamation',
    sub: isEdit ? `${rec.roomLabel} · déclarée le ${fmtDate(rec.declaredAt)}` : 'Signalement maintenance / vie de la résidence',
    body:`<div class="fgrid">
      ${isEdit
        ? `<div class="field full"><label>Chambre concernée</label><input class="inp" disabled value="${esc(rec.roomLabel)} · ${esc(rec.bloc)}"></div>`
        : `<div class="field"><label>Chambre concernée <span class="req">*</span></label><select class="inp" name="roomId" id="rcf-room" required>${roomOpts}</select></div>
           <div class="field"><label>Déclarée par</label><select class="inp" name="dby" id="rcf-dby">
             <option value="agent">Agent — ${esc(Session.user.name)}</option><option value="etudiant">Étudiant de la chambre</option></select></div>
           <div class="field full" id="rcf-stuwrap" hidden><label>Étudiant déclarant</label><select class="inp" name="studentId" id="rcf-student"><option value="">—</option>${occupantsOpts}</select></div>`}
      <div class="field"><label>Type <span class="req">*</span></label><select class="inp" name="type">${TYPES_REC.map(([v,l])=>`<option value="${v}" ${c.type===v?'selected':''}>${l}</option>`).join('')}</select></div>
      <div class="field"><label>Priorité</label><select class="inp" name="priorite">${PRIORITES.map(([v,l])=>`<option value="${v}" ${c.priorite===v?'selected':''}>${l}</option>`).join('')}</select></div>
      ${isEdit?`<div class="field"><label>Statut</label><select class="inp" name="statut">${REC_STATUTS.map(([v,l])=>`<option value="${v}" ${c.statut===v?'selected':''}>${l}</option>`).join('')}</select></div>
      <div class="field"><label>Assignée à</label><select class="inp" name="assigned"><option value="">—</option>${agents.map(u=>`<option ${c.assignedToName===u.name?'selected':''}>${esc(u.name)}</option>`).join('')}</select></div>`:''}
      <div class="field full"><label>Description <span class="req">*</span></label><textarea class="inp" name="description" required>${esc(c.description||'')}</textarea></div>
    </div>`,
    footer:`<button class="btn btn-ghost" data-mclose>Annuler</button><button class="btn btn-primary" data-ok>${isEdit?'Enregistrer':'Déclarer'}</button>`,
    onMount(ov){
      const form = ov.querySelector('form');
      /* Cascade : changement de chambre → liste des étudiants occupants */
      const roomSel = ov.querySelector('#rcf-room'), dby = ov.querySelector('#rcf-dby'),
            stuWrap = ov.querySelector('#rcf-stuwrap'), stuSel = ov.querySelector('#rcf-student');
      async function syncDeclarant(){
        if (!roomSel || !dby) return;
        if (dby.value !== 'etudiant'){ stuWrap.hidden = true; return; }
        stuWrap.hidden = false;
        const s2 = await snapshot();
        const occ = occupantIds(s2, roomSel.value);
        stuSel.innerHTML = '<option value="">— choisir —</option>' +
          occ.map(s=>`<option value="${s.id}">${esc(s.nom)} ${esc(s.prenom)}</option>`).join('');
      }
      if (roomSel){ roomSel.addEventListener('change', syncDeclarant); dby.addEventListener('change', syncDeclarant); }
      ov.querySelector('[data-ok]').addEventListener('click', async e=>{
        e.preventDefault();
        await safe(async ()=>{
          const fd = Object.fromEntries(new FormData(form).entries());
          if (!fd.description.trim()) throw AppError('La description est obligatoire.');
          if (isEdit){
            const patch = { type:fd.type, priorite:fd.priorite, description:fd.description.trim(),
                            statut:fd.statut, assignedToName: fd.assigned || null };
            if (fd.statut==='resolue' && !rec.resolvedAt) patch.resolvedAt = nowISO();
            if (fd.statut!=='resolue') patch.resolvedAt = null;
            await Store.update('complaints', rec.id, patch);
            toast('Réclamation mise à jour.','success');
          } else {
            const s2 = await snapshot();
            const room = s2.rooms.find(r=>r.id===fd.roomId);
            if (!room) throw AppError('Choisissez une chambre.');
            if (fd.dby==='etudiant'){
              if (!fd.studentId) throw AppError('Choisissez l\u2019étudiant déclarant.');
            }
            let declaredByName = Session.user.name, declaredByType = 'agent';
            if (fd.dby==='etudiant'){
              const st = s2.students.find(x=>x.id===fd.studentId);
              declaredByName = st ? `${st.nom} ${st.prenom}` : 'Étudiant';
              declaredByType = 'etudiant';
            }
            await Store.insert('complaints', {
              id:uid(), roomId:room.id, roomLabel:roomLabel(room), bloc:room.bloc,
              type:fd.type, description:fd.description.trim(), priorite:fd.priorite,
              statut:'nouvelle', declaredByType, declaredByName,
              declaredAt:nowISO(), assignedToName:null, resolvedAt:null
            });
            toast('Réclamation enregistrée.','success');
          }
          Modal.close(); await refresh();
        });
      });
    }
  });
}
/* — Détail réclamation — */
async function openComplaintDetail(id){
  const snap = await snapshot();
  const c = snap.complaints.find(x=>x.id===id);
  if (!c) return toast('Réclamation introuvable.','error');
  const D = (t,v)=>`<div><dt>${t}</dt><dd>${v}</dd></div>`;
  Modal.open({
    title:'Réclamation #'+c.id.slice(0,4).toUpperCase(), sub:`${esc(c.roomLabel)} · ${esc(c.bloc)}`, wide:true,
    body:`<div style="display:flex;gap:8px;margin-bottom:14px">${b(REC_STATUT_BADGE[c.statut])}${b(PRIO_BADGE[c.priorite])}
        <span class="badge b-neutral">${(TYPES_REC.find(t=>t[0]===c.type)||['','Inconnu'])[1]}</span></div>
      <p style="background:#f6f8f7;border:1px solid var(--line);border-radius:9px;padding:13px 15px;font-size:14px;line-height:1.6">${esc(c.description)}</p>
      <dl class="dl two" style="margin-top:14px">
        ${D('Déclarée par', `${esc(c.declaredByName)} <span style="font-weight:400;color:var(--muted)">(${c.declaredByType==='agent'?'agent':'étudiant(e)'})</span>`)}
        ${D('Date de déclaration', fmtDateTime(c.declaredAt))}
        ${D('Assignée à', esc(c.assignedToName)||'<span style="color:var(--muted)">Personne</span>')}
        ${D('Date de résolution', c.resolvedAt?fmtDateTime(c.resolvedAt):'—')}
      </dl>
      <div class="sec-title" style="margin-top:16px">Historique de la chambre ${esc(c.roomLabel)}</div>
      ${(()=>{ const others = snap.complaints.filter(x=>x.roomId===c.roomId && x.id!==c.id)
          .sort((a,b)=>b.declaredAt.localeCompare(a.declaredAt)).slice(0,5);
        return others.length ? '<ul class="list-plain">'+others.map(o=>
          `<li>${b(REC_STATUT_BADGE[o.statut])}<span class="grow">${(TYPES_REC.find(t=>t[0]===o.type)||['','Inconnu'])[1]} — ${esc(o.description.slice(0,70))}</span>
           <span style="font-size:11.5px;color:var(--muted)">${fmtDate(o.declaredAt)}</span>
           <button class="btn-icon hov-info" data-goto="${o.id}">${Icons.eye}</button></li>`).join('')+'</ul>'
          : '<div class="empty" style="padding:12px">Aucune autre réclamation pour cette chambre.</div>'; })()}`,
    footer:`<button class="btn btn-ghost" data-mclose>Fermer</button>
      ${(isAdmin()||c.bloc===Session.bloc())?`<button class="btn btn-primary" data-edit>${Icons.edit} Modifier / changer le statut</button>`:''}`,
    onMount(ov){
      const eb = ov.querySelector('[data-edit]');
      if (eb) eb.addEventListener('click', ()=>{ Modal.close(); openComplaintForm(c); });
      ov.querySelectorAll('[data-goto]').forEach(bt=>bt.addEventListener('click', ()=>{ Modal.close(); openComplaintDetail(bt.dataset.goto); }));
    }
  });
}

/* ══════════════ SECTION 13 — MODULE HISTORIQUE D'AFFECTATION ══════════════ */
const HistView = { academicYear:academicYearFor(nowISO()), bloc:'', type:'', from:'', to:'', q:'' };
async function renderHistory(){
  const snap = await snapshot();
  const history = Scope.history(snap);
  const academicYears = [...new Set([academicYearFor(nowISO()), ...history.map(h=>academicYearFor(h.date))].filter(Boolean))].sort((a,b)=>b.localeCompare(a));
  const hasOutOfYear = history.some(h=>!academicYearFor(h.date));
  $('h-academic-year').innerHTML = academicYears.map(year=>`<option value="${year}">${year}</option>`).join('') +
    (hasOutOfYear?'<option value="outside">Hors année universitaire</option>':'');
  $('h-academic-year').value = HistView.academicYear;
  const blocs = [...new Set(snap.rooms.map(r=>r.bloc))];
  $('h-bloc').innerHTML = '<option value="">Bloc : tous</option>' + blocs.map(bl=>`<option ${HistView.bloc===bl?'selected':''}>${bl}</option>`).join('');
  if (!isAdmin()){ $('h-bloc').value = Session.bloc(); $('h-bloc').disabled = true; } else $('h-bloc').disabled = false;
  $('h-type').innerHTML = '<option value="">Type : tous</option><option value="entree">Entrées</option><option value="sortie">Sorties</option><option value="transfert">Transferts</option>';
  $('h-type').value = HistView.type; $('h-from').value = dateInputValue(HistView.from); $('h-to').value = dateInputValue(HistView.to);
  $('h-searchwrap').innerHTML = Icons.search + `<input class="inp" id="h-q" placeholder="Étudiant, chambre…" value="${esc(HistView.q)}">`;
  $('h-scopenote').innerHTML = isAdmin() ? '' :
    `<div class="scope-note">Périmètre agent : mouvements du ${Session.bloc()} uniquement.</div>`;
  await renderHistoryList();
}
async function renderHistoryList(){
  const snap = await snapshot();
  let list = historyRecordsForView(snap);
  list.sort((a,b)=>b.date.localeCompare(a.date));
  $('h-count').textContent = `${list.length} mouvement${list.length>1?'s':''}`;
  $('tb-sub').textContent = 'Chaque entrée, sortie et transfert est tracé avec son auteur.';
  $('h-list').innerHTML = list.length ? list.map(h=>{
    const ic = h.type==='entree'?'ic-in':h.type==='sortie'?'ic-out':'ic-tr';
    const verb = h.type==='entree' ? `Entrée dans la chambre <b>${esc(h.roomLabel)}</b>`
      : h.type==='sortie' ? `Sortie de la chambre <b>${esc(h.roomLabel)}</b>`
      : `Transfert vers <b>${esc(h.roomLabel)}</b>${h.fromRoomLabel?` <span style="color:var(--muted)">(depuis ${esc(h.fromRoomLabel)})</span>`:''}`;
    const academicYear = academicYearFor(h.date) || 'Hors année universitaire';
    return `<li><div class="when"><b>${fmtDate(h.date)}</b>${fmtTime(h.date)}</div>
      <span class="ic ${ic}">${h.type==='entree'?Icons.check:h.type==='sortie'?Icons.out:Icons.swap}</span>
      <div class="what"><b>${esc(h.studentName)}</b> — ${verb} ${b(BLOC_BADGE[h.type])}
        <div class="sub">Année universitaire : ${esc(academicYear)} · Motif : ${esc(h.motif)} · effectué par ${esc(h.userName)} · ${esc(h.bloc)}</div></div></li>`;
  }).join('') : '<div class="empty">Aucun mouvement ne correspond aux filtres.</div>';
}
function historyRecordsForView(snap){
  let list = Scope.history(snap);
  const f = HistView;
  if (!isAdmin() || f.bloc) list = list.filter(h=>h.bloc===(isAdmin()?f.bloc:Session.bloc()));
  if (f.type) list = list.filter(h=>h.type===f.type);
  if (f.academicYear==='outside') list = list.filter(h=>!academicYearFor(h.date));
  else if (f.academicYear) list = list.filter(h=>academicYearFor(h.date)===f.academicYear);
  if (f.from) list = list.filter(h=>h.date >= f.from+'T00:00');
  if (f.to) list = list.filter(h=>h.date <= f.to+'T23:59');
  if (f.q){ const t=f.q.toLowerCase(); list = list.filter(h=>(h.studentName+' '+h.roomLabel+' '+h.motif).toLowerCase().includes(t)); }
  return list;
}

/* ══════════════ SECTION 14 — MODULE UTILISATEURS (admin uniquement) ══════════════ */
async function renderUsers(){
  requireAdmin();
  const users = (await Store.list('users')).slice().sort((a,b)=>a.name.localeCompare(b.name));
  $('us-count').textContent = `${users.length} compte${users.length>1?'s':''}`;
  $('tb-sub').textContent = 'Créer, modifier ou désactiver les comptes agents et administrateurs.';
  $('us-tbody').innerHTML = users.map(u=>{
    const self = u.id === Session.user.id;
    return `<tr>
      <td class="name"><b>${esc(u.name)}</b><span>${self?'(vous)':''}</span></td>
      <td class="mono">${esc(u.username)}</td>
      <td class="mono">${esc(u.phone||'—')}</td>
      <td>${u.role==='admin'?b(['b-gold','Administrateur']):b(['b-info','Utilisateur'])}</td>
      <td>${u.active?b(['b-dot b-ok','Actif']):b(['b-dot b-neutral','Désactivé'])}</td>
      <td class="actions">
        <button class="btn-icon hov-warn" data-action="user-edit" data-id="${u.id}" title="Modifier">${Icons.edit}</button>
        ${!self?`<button class="btn-icon hov-${u.active?'warn':'ok'}" data-action="user-toggle" data-id="${u.id}" title="${u.active?'Désactiver':'Réactiver'}">${Icons.power}</button>
        <button class="btn-icon hov-bad" data-action="user-del" data-id="${u.id}" title="Supprimer">${Icons.trash}</button>`:''}
      </td></tr>`;
  }).join('');
}
async function openUserForm(user){
  requireAdmin();
  const u = user || { role:'user', active:true };
  const snap = await snapshot();
  const blocs = [...new Set(snap.rooms.map(r=>r.bloc))];
  const self = user && user.id === Session.user.id;
  Modal.open({
    title: user ? 'Modifier le compte' : 'Nouvel utilisateur',
    sub: user ? u.name : 'Création d\u2019un compte utilisateur',
    body:`<div class="fgrid">
      <div class="field full"><label>Nom complet <span class="req">*</span></label><input class="inp" name="name" required value="${esc(u.name)}"></div>
      <div class="field"><label>Nom d\u2019utilisateur <span class="req">*</span></label><input class="inp" name="username" required value="${esc(u.username)}" ${self?'disabled':''}></div>
      <div class="field"><label>Téléphone</label><input class="inp" name="phone" value="${esc(u.phone||'')}" placeholder="05…"></div>
      <div class="field"><label>Avatar</label><input class="inp" name="avatar" value="${esc(u.avatar||'')}" placeholder="Initiales ou image"></div>
      <div class="field"><label>${user?'Nouveau mot de passe':'Mot de passe <span class="req">*</span>'}</label>
        <input class="inp" type="password" name="password" placeholder="${user?'(laisser vide = inchangé)':''}" ${user?'':'required'}></div>
      <div class="field"><label>Rôle</label><select class="inp" name="role" id="usf-role" ${self?'disabled':''}>
        <option value="user" ${u.role==='user'?'selected':''}>Utilisateur</option>
        <option value="admin" ${u.role==='admin'?'selected':''}>Administrateur</option></select></div>
      <div class="field"><label>Bloc de rattachement</label><select class="inp" name="bloc" id="usf-bloc">
        <option value="">— (administrateur) —</option>
        ${blocs.map(bl=>`<option ${u.bloc===bl?'selected':''}>${bl}</option>`).join('')}</select></div>
      <div class="field full"><label style="display:flex;align-items:center;gap:8px;text-transform:none;letter-spacing:0">
        <input type="checkbox" name="active" ${u.active?'checked':''} style="width:16px;height:16px"> Compte actif</label></div>
    </div>
    <div style="margin-top:12px;font-size:11.5px;color:var(--muted)">Les mots de passe sont enregistrés sous forme de condensés PBKDF2 salés, et non en clair.</div>`,
    footer:`<button class="btn btn-ghost" data-mclose>Annuler</button><button class="btn btn-primary" data-ok>${user?'Enregistrer':'Créer le compte'}</button>`,
    onMount(ov){
      ov.querySelector('[data-ok]').addEventListener('click', async e=>{
        e.preventDefault();
        await safe(async ()=>{
          const fd = Object.fromEntries(new FormData(ov.querySelector('form')).entries());
          if (!fd.name.trim()) throw AppError('Le nom est obligatoire.');
          const role = self ? u.role : fd.role;
          const bloc = null;
          if (!user && !fd.username.trim()) throw AppError('Nom d\u2019utilisateur obligatoire.');
          const username = (user ? u.username : fd.username.trim().toLowerCase());
          const dup = (await Store.list('users')).find(x=>x.username.toLowerCase()===username && x.id!==(user?.id||''));
          if (dup) throw AppError('Cet identifiant existe déjà.');
          const data = { name:fd.name.trim(), username, phone:String(fd.phone||'').trim(), avatar:String(fd.avatar||'').trim(), role, bloc, active: !!fd.active || fd.active==='on' };
          if (fd.password) data.password = await hashPassword(fd.password);
          if (user){ await Store.update('users', user.id, data); toast('Compte mis à jour.','success'); }
          else { await Store.insert('users', { id:uid(), password:data.password, ...data }); toast('Compte créé.','success'); }
          Modal.close(); await refresh();
        });
      });
    }
  });
}

/* ══════════════ SECTION 15 — EXPORTS CSV ══════════════ */
async function exportRooms(){
  const snap = await snapshot();
  const list = Scope.rooms(snap).sort((a,b)=>compareNames(a.bloc,b.bloc) || compareNames(roomLabel(a), roomLabel(b)));
  exportCSV('chambres.csv',
    ['Bloc','Chambre','Étage','Capacité','Occupants','Statut','Hors service','Note'],
    list.map(r=>{
      const occ = occupantIds(snap, r.id).length;
      const status = roomDerivedStatus(snap, r);
      const statusLabel = status === 'hs' ? 'Hors service' : status === 'complet' ? 'Complète' : 'Disponible';
      return [r.bloc, roomLabel(r), floorNumber(r.numero), r.capacite, occ, statusLabel, r.horsService ? 'Oui' : 'Non', r.notes || ''];
    }));
}
async function exportRoomsPdf(){
  const snap=await snapshot();
  const rooms=Scope.rooms(snap);
  let pages;
  if(RoomsView.bloc){
    const block=RoomsView.bloc;
    const blockRooms=rooms.filter(room=>room.bloc===block);
    const floors=[...new Set(blockRooms.map(room=>floorNumber(room.numero)))].sort((a,b)=>a-b);
    pages=floors.map(floor=>{
      const floorRooms=blockRooms.filter(room=>floorNumber(room.numero)===floor).sort((a,b)=>compareNames(roomLabel(a),roomLabel(b)));
      const cards=floorRooms.map(room=>{
        const occupants=occupantIds(snap,room.id).map(student=>`<li>${esc(student.prenom)} ${esc(student.nom)}</li>`).join('');
        return `<article class="room-export-card"><h2>${esc(roomLabel(room))}</h2>${occupants?`<ul>${occupants}</ul>`:''}</article>`;
      }).join('');
      return `<section class="room-export-page"><header><p>HÉBERGIA · RÉPARTITION DES CHAMBRES</p><div><h1>${floorLabel(floor)}</h1><span>${esc(block)}</span></div></header><div class="room-export-grid">${cards}</div></section>`;
    });
  } else {
    const blocks=[...new Set(rooms.map(room=>room.bloc))].sort(compareNames);
    const groups=[
      {key:'mixte',title:'Non défini'},
      {key:'fille',title:'Réservé aux filles'},
      {key:'garcon',title:'Réservé aux garçons'}
    ];
    const groupMarkup=groups.map(group=>{
      const groupBlocks=blocks.filter(block=>(['fille','garcon'].includes(blockGender(snap,block))?blockGender(snap,block):'mixte')===group.key);
      if(!groupBlocks.length) return '';
      const groupRooms=groupBlocks.flatMap(block=>rooms.filter(room=>room.bloc===block));
      const totalRooms=groupRooms.length;
      const occupied=groupRooms.reduce((sum,room)=>sum+occupantIds(snap,room.id).length,0);
      const capacity=groupRooms.reduce((sum,room)=>sum+room.capacite,0);
      const freePlaces=Math.max(0,capacity-occupied);
      const roomsWithFreePlaces=groupRooms.filter(room=>occupantIds(snap,room.id).length<room.capacite).length;
      const occupationRate=capacity?Math.round(occupied/capacity*100):0;
      const cards=groupBlocks.map((block,index)=>{
        const blockRooms=rooms.filter(room=>room.bloc===block);
        const floors=new Set((snap.floors||[]).filter(floor=>floor.bloc===block).map(floor=>Number(floor.numero)));
        blockRooms.forEach(room=>floors.add(floorNumber(room.numero)));
        const blockOccupants=blockRooms.reduce((sum,room)=>sum+occupantIds(snap,room.id).length,0);
        const blockCapacity=blockRooms.reduce((sum,room)=>sum+room.capacite,0);
        return `<article class="block-export-card block-tone-${index%6}"><h2>${esc(block)}</h2><p>${esc(blockGenderLabel(blockGender(snap,block)))}</p><div class="block-export-stats"><div><b>${blockRooms.length}</b><span>chambres</span></div><div><b>${floors.size}</b><span>étages</span></div><div><b>${blockOccupants}/${blockCapacity}</b><span>résidents / lits</span></div></div></article>`;
      }).join('');
      return `<section class="block-export-group"><div class="block-export-group-heading"><h2>${group.title}</h2><p>${totalRooms} chambres · ${freePlaces} places libres · ${roomsWithFreePlaces} chambres disponibles · ${occupationRate}% d’occupation</p></div><div class="block-export-grid">${cards}</div></section>`;
    }).join('');
    pages=[`<section class="room-export-overview"><header><p>HÉBERGIA · STATISTIQUES DE LA RÉSIDENCE</p><div><h1>Blocs</h1><span>${blocks.length} blocs</span></div></header>${groupMarkup}</section>`];
  }
  if(!pages.length) return toast('Aucune chambre à exporter.','warning');
  const printRoot=document.createElement('main');
  printRoot.className='room-print-export';
  printRoot.innerHTML=pages.join('');
  const cleanup=()=>{
    document.body.classList.remove('room-print-mode');
    printRoot.remove();
    window.removeEventListener('afterprint',cleanup);
  };
  document.body.classList.add('room-print-mode');
  document.body.appendChild(printRoot);
  window.addEventListener('afterprint',cleanup,{once:true});
  try{ window.focus(); window.print(); }
  catch(error){ cleanup(); throw error; }
}
async function exportHistory(){
  const snap = await snapshot();
  const list = historyRecordsForView(snap).sort((a,b)=>b.date.localeCompare(a.date));
  exportCSV('historique.csv',
    ['Date','Heure','Année universitaire','Type','Étudiant','Bloc','Chambre','Motif','Utilisateur'],
    list.map(h=>[fmtDate(h.date),fmtTime(h.date),h.academicYear||academicYearFor(h.date)||'Hors année universitaire',h.type,h.studentName,h.bloc,h.roomLabel,h.motif,h.userName]));
}
async function exportReports(){
  const snap = await snapshot();
  const rooms = Scope.rooms(snap), roomById=new Map(rooms.map(room=>[room.id,room]));
  const usable=rooms.filter(room=>room.statut!=='hors_service');
  const active=snap.students.filter(student=>student.statut==='actif');
  const blocks = [...new Set(rooms.map(room=>room.bloc))].sort(compareNames);
  const rows = blocks.map(bloc=>{
    const blockRooms = usable.filter(room=>room.bloc===bloc);
    const roomIds=new Set(blockRooms.map(room=>room.id));
    const capacity = blockRooms.reduce((sum,room)=>sum+room.capacite,0);
    const occupants = active.filter(student=>roomIds.has(student.chambreId)).length;
    const freeBeds=Math.max(0,capacity-occupants);
    const roomsWithSpaces=blockRooms.filter(room=>roomDerivedStatus(snap,room)==='disponible').length;
    const outOfService=rooms.filter(room=>room.bloc===bloc&&room.statut==='hors_service').length;
    return [bloc, blockRooms.length, capacity, occupants, freeBeds, capacity ? `${Math.round((occupants/capacity)*100)}%` : '—', roomsWithSpaces, outOfService];
  });
  exportCSV('rapports.csv', ['Bloc','Chambres utilisables','Lits utilisables','Résidents affectés','Lits libres','Taux d’occupation','Chambres avec places','Chambres hors service'], rows);
  if(isAdmin()){
    const movements=summarizeMonthlyMovements(Scope.history(snap),new Date(),ReportsView.movementMonths);
    exportCSV(`mouvements-${ReportsView.movementMonths}-mois.csv`,
      ['Mois','Entrées','Sorties','Transferts','Solde entrées/sorties'],
      movements.map(month=>[month.key,month.entree,month.sortie,month.transfert,month.net]));
  }
}
async function exportStudents(){
  const snap = await snapshot();
  const list = Scope.students(snap).sort((a,b)=>a.nom.localeCompare(b.nom));
  exportCSV('etudiants.csv',
    ['Matricule','Nom','Prénom','Nom Complet','Année Bac','Naissance','Nationalité','Faculté','Niveau','Téléphone','Rue','Commune','Wilaya','Statut','Chambre'],
    list.map(s=>{ const r = snap.rooms.find(x=>x.id===s.chambreId);
      return [s.matricule,s.nom,s.prenom,s.nomComplet||[s.nom,s.prenom].filter(Boolean).join(' '),s.anneeBac,fmtDate(s.dateNaissance),s.nationalite,s.faculte,s.niveau,s.telephone,s.rue,s.commune,s.wilaya,s.statut,r?roomLabel(r):'']; }));
}
async function exportRecs(){
  const snap = await snapshot();
  const list = Scope.complaints(snap).sort((a,b)=>b.declaredAt.localeCompare(a.declaredAt));
  exportCSV('reclamations.csv',
    ['Réf.','Chambre','Bloc','Type','Priorité','Statut','Description','Déclarée par','Le','Assignée à','Résolue le'],
    list.map(c=>['#'+c.id.slice(0,4).toUpperCase(),c.roomLabel,c.bloc,
      (TYPES_REC.find(t=>t[0]===c.type)||['','Inconnu'])[1],c.priorite,REC_STATUTS.find(s=>s[0]===c.statut)[1],
      c.description,c.declaredByName,fmtDateTime(c.declaredAt),c.assignedToName||'',c.resolvedAt?fmtDateTime(c.resolvedAt):'']));
}
async function exportDataJSON(){ const snap=await snapshot(); const students=(await Store.list('students')).map(s=>({...s,nomComplet:s.nomComplet||[s.nom,s.prenom].filter(Boolean).join(' ')})); const blob=new Blob([JSON.stringify({exportedAt:nowISO(),version:1,data:{students,complaints:snap.complaints}},null,2)],{type:'application/json'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`hebergia-data-${new Date().toISOString().slice(0,10)}.json`; a.click(); URL.revokeObjectURL(a.href); toast('Données JSON exportées.','success'); }
function selectedExportFormat(){
  const format=localStorage.getItem('hebergia_export_format');
  return ['excel','csv','json'].includes(format)?format:'excel';
}
function exportControlMarkup(kind,action){
  const format=selectedExportFormat(), label=format==='excel'?'Excel':format.toUpperCase();
  return `<div class="view-export" data-format="${format}" style="display:inline-flex;align-items:stretch;position:relative"><button class="btn btn-ghost" type="button" data-action="${action}" data-export-kind="${kind}" data-export-format-label style="border-top-right-radius:0;border-bottom-right-radius:0">Exporter (${label})</button><details class="settings-dropdown view-export-menu"><summary class="btn btn-ghost" title="Choisir le format d’export" aria-label="Choisir le format d’export" style="width:36px;justify-content:center;padding:8px;border-top-left-radius:0;border-bottom-left-radius:0;margin-left:-1px">${Icons.chevronDown}</summary><div class="settings-menu" style="left:auto;right:0"><button class="settings-menu-item" type="button" data-action="select-export-format" data-export-format="excel" aria-pressed="${format==='excel'}">Excel (.xlsx)</button><button class="settings-menu-item" type="button" data-action="select-export-format" data-export-format="csv" aria-pressed="${format==='csv'}">CSV</button><button class="settings-menu-item" type="button" data-action="select-export-format" data-export-format="json" aria-pressed="${format==='json'}">JSON</button></div></details></div>`;
}
async function exportDataExcel(scope='all'){
  const ExcelJS=window.ExcelJS||await window.loadExcelJS?.();
  if(!ExcelJS) throw AppError('Le module Excel est indisponible.');
  const snap=await snapshot();
  const studentHeaders=['Identifiant','Matricule','Numéro d’inscription','Année du Bac','Nom','Prénom','Nom Complet','Sexe','Nationalité','Date de naissance','Lieu de naissance','Filière','Faculté / Institut','Niveau','Téléphone','Email','Rue','Commune','Wilaya','Statut','ID chambre'];
  const students=scope==='students'?Scope.students(snap):scope==='all'?snap.students:[];
  const studentRows=students.map(s=>[s.id,s.matricule,s.numeroInscription,s.anneeBac,s.nom,s.prenom,s.nomComplet||[s.nom,s.prenom].filter(Boolean).join(' '),s.sexe,s.nationalite,s.dateNaissance,s.lieuNaissance,s.filiere,s.faculte,s.niveau,s.telephone,s.email,s.rue,s.commune,s.wilaya,s.statut,s.chambreId]);
  const complaintHeaders=['Identifiant','ID chambre','Chambre','Bloc','Type','Description','Priorité','Statut','Type déclarant','Déclaré par','Date de déclaration','Assignée à','Date de résolution'];
  const complaints=scope==='complaints'?Scope.complaints(snap):scope==='all'?snap.complaints:[];
  const complaintRows=complaints.map(c=>[c.id,c.roomId,c.roomLabel,c.bloc,c.type,c.description,c.priorite,c.statut,c.declaredByType,c.declaredByName,c.declaredAt,c.assignedToName,c.resolvedAt]);
  const roomHeaders=['Identifiant','Bloc','Chambre','Étage','Capacité','Occupants','Statut','Hors service','Note'];
  const rooms=scope==='rooms'?Scope.rooms(snap):scope==='all'?(snap.rooms||[]):[];
  const roomRows=rooms.map(r=>{ const occ=occupantIds(snap,r.id); const status=roomDerivedStatus(snap,r); return [r.id,r.bloc,roomLabel(r),floorNumber(r.numero),r.capacite,occ.length,status==='hs'?'Hors service':status==='complet'?'Complète':'Disponible',r.horsService?'Oui':'Non',r.notes||'']; });
  const historyHeaders=['Date','Heure','Année universitaire','Type','Étudiant','Bloc','Chambre','Motif','Utilisateur'];
  const historyList=scope==='history' ? historyRecordsForView(snap).sort((a,b)=>b.date.localeCompare(a.date)) : [];
  const historyRows=historyList.map(h=>[fmtDate(h.date),fmtTime(h.date),academicYearFor(h.date)||'Hors année universitaire',h.type,h.studentName,h.bloc,h.roomLabel,h.motif,h.userName]);
  const reportHeaders=['Bloc','Chambres','Lits','Occupants','Taux d’occupation'];
  const reportRows=scope==='reports' ? [...new Set((snap.rooms||[]).map(r=>r.bloc))].sort().map(bloc=>{ const items=(snap.rooms||[]).filter(r=>r.bloc===bloc && r.statut!=='hors_service'); const capacity=items.reduce((sum,r)=>sum+r.capacite,0); const occ=(snap.students||[]).filter(s=>s.statut==='actif' && s.chambreId && (snap.rooms||[]).find(r=>r.id===s.chambreId)?.bloc===bloc).length; return [bloc, items.length, capacity, occ, capacity ? `${Math.round((occ/capacity)*100)}%` : '0%']; }) : [];
  const workbook=new ExcelJS.Workbook();
  if(scope!=='complaints'&&scope!=='rooms'&&scope!=='history'&&scope!=='reports'){
    const studentSheet=workbook.addWorksheet('Étudiants');
    studentSheet.addRow(studentHeaders);
    studentRows.forEach(row=>studentSheet.addRow(row));
  }
  if(scope!=='students'&&scope!=='rooms'&&scope!=='history'&&scope!=='reports'){
    const complaintSheet=workbook.addWorksheet('Réclamations');
    complaintSheet.addRow(complaintHeaders);
    complaintRows.forEach(row=>complaintSheet.addRow(row));
  }
  if(scope==='rooms'||scope==='all'){
    const roomSheet=workbook.addWorksheet('Chambres');
    roomSheet.addRow(roomHeaders);
    roomRows.forEach(row=>roomSheet.addRow(row));
  }
  if(scope==='history'){
    const historySheet=workbook.addWorksheet('Historique');
    historySheet.addRow(historyHeaders);
    historyRows.forEach(row=>historySheet.addRow(row));
  }
  if(scope==='reports'){
    const reportSheet=workbook.addWorksheet('Rapports');
    reportSheet.addRow(reportHeaders);
    reportRows.forEach(row=>reportSheet.addRow(row));
    if(isAdmin()){
      const movementSheet=workbook.addWorksheet('Mouvements');
      movementSheet.addRow(['Mois','Entrées','Sorties','Transferts','Solde entrées/sorties']);
      summarizeMonthlyMovements(Scope.history(snap),new Date(),ReportsView.movementMonths)
        .forEach(month=>movementSheet.addRow([month.key,month.entree,month.sortie,month.transfert,month.net]));
    }
  }
  const buffer=await workbook.xlsx.writeBuffer();
  const blob=new Blob([buffer],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
  const url=URL.createObjectURL(blob), link=document.createElement('a');
  link.href=url; link.download=`hebergia-${scope==='all'?'data':scope}-${new Date().toISOString().slice(0,10)}.xlsx`; link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  toast('Données Excel exportées.','success');
}
async function exportDataCSV(){ await exportStudents(); await exportRecs(); toast('Deux fichiers CSV exportés : étudiants et réclamations.','success'); }
async function exportViewJSON(scope){
  const snap=await snapshot();
  const records = scope==='students' ? (await Store.list('students')).map(s=>({...s,nomComplet:s.nomComplet||[s.nom,s.prenom].filter(Boolean).join(' ')})) : scope==='rooms' ? Scope.rooms(snap) : scope==='history' ? historyRecordsForView(snap).map(h=>({...h, academicYear:academicYearFor(h.date)||'Hors année universitaire'})) : scope==='reports' ? { generatedAt: nowISO(), movementPeriodMonths:ReportsView.movementMonths, movements:isAdmin()?summarizeMonthlyMovements(Scope.history(snap),new Date(),ReportsView.movementMonths):null, summary: { totalRooms: (snap.rooms||[]).length, totalResidents: (snap.students||[]).filter(s=>s.statut==='actif').length, totalComplaints: Scope.complaints(snap).length } } : Scope.complaints(snap);
  const key = scope==='students' ? 'students' : scope==='rooms' ? 'rooms' : scope==='history' ? 'history' : scope==='reports' ? 'reports' : 'complaints';
  const label = scope==='students' ? 'Étudiants' : scope==='rooms' ? 'Chambres' : scope==='history' ? 'Historique' : scope==='reports' ? 'Rapports' : 'Réclamations';
  const blob=new Blob([JSON.stringify({exportedAt:nowISO(),version:1,data:{[key]:records}},null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob), link=document.createElement('a');
  link.href=url; link.download=`hebergia-${scope}-${new Date().toISOString().slice(0,10)}.json`; link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  toast(`Données ${label.toLowerCase()} exportées en JSON.`,'success');
}

const normalizeExcelHeader=value=>String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
function excelValue(row,aliases){
  const wanted=aliases.map(normalizeExcelHeader);
  const entry=Object.entries(row).find(([header])=>wanted.includes(normalizeExcelHeader(header)));
  return entry?.[1];
}
const excelText=value=>String(value??'').trim();
function excelCellValue(value){
  if(value&&typeof value==='object'&&!(value instanceof Date)){
    if('result' in value) return excelCellValue(value.result);
    if('text' in value) return value.text;
    if('richText' in value) return value.richText.map(part=>part.text).join('');
  }
  return value;
}
function excelRows(sheet){
  const headers=sheet.getRow(1).values.slice(1);
  const rows=[];
  sheet.eachRow((row,rowNumber)=>{
    if(rowNumber===1) return;
    const record={};
    headers.forEach((header,index)=>{ if(header!==undefined&&header!==null&&String(header).trim()) record[String(header)]=excelCellValue(row.getCell(index+1).value); });
    if(Object.values(record).some(value=>excelText(value))) rows.push(record);
  });
  return rows;
}
function excelDate(value,withTime=false){
  if(value===undefined||value===null||value==='') return withTime?null:'';
  const formatDate=(year,month,day)=>`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  if(value instanceof Date){
    if(Number.isNaN(value.getTime())) throw AppError('Une date Excel est invalide.');
    return withTime?value.toISOString():formatDate(value.getFullYear(),value.getMonth()+1,value.getDate());
  }
  if(typeof value==='number'){
    const date=new Date(Date.UTC(1899,11,30)+value*86400000);
    if(Number.isNaN(date.getTime())) throw AppError('Une date Excel est invalide.');
    return withTime?date.toISOString():formatDate(date.getUTCFullYear(),date.getUTCMonth()+1,date.getUTCDate());
  }
  const text=String(value).trim();
  const iso=text.match(/^(\d{4})-(\d{2})-(\d{2})(.*)$/);
  if(iso){
    const dateOnly=parseDisplayDate(`${iso[3]}/${iso[2]}/${iso[1]}`);
    if(dateOnly===null) throw AppError('Une date Excel est invalide.');
    if(!withTime) return dateOnly;
    const date=new Date(text);
    if(Number.isNaN(date.getTime())) throw AppError('Une date Excel est invalide.');
    return date.toISOString();
  }
  const dmy=text.match(/^(\d{2}\/\d{2}\/\d{4})(.*)$/);
  if(dmy){
    const dateOnly=parseDisplayDate(dmy[1]);
    if(dateOnly===null) throw AppError('Une date Excel est invalide.');
    if(!withTime||!dmy[2].trim()) return dateOnly;
    const time=dmy[2].match(/(\d{2}:\d{2}(?::\d{2})?)/)?.[1]||'00:00';
    const date=new Date(`${dateOnly}T${time}`);
    if(Number.isNaN(date.getTime())) throw AppError('Une date Excel est invalide.');
    return date.toISOString();
  }
  const date=new Date(text);
  if(Number.isNaN(date.getTime())) throw AppError('Une date Excel est invalide.');
  return withTime?date.toISOString():formatDate(date.getFullYear(),date.getMonth()+1,date.getDate());
}
function parseCSVRows(text){
  text=String(text||'').replace(/^\uFEFF/,'');
  const firstLine=text.split(/\r?\n/,1)[0];
  const delimiters=[';',',','\t'];
  const delimiter=delimiters.sort((a,b)=>firstLine.split(b).length-firstLine.split(a).length)[0];
  const table=[]; let row=[], value='', quoted=false;
  for(let index=0;index<text.length;index++){
    const char=text[index];
    if(char==='"'&&quoted&&text[index+1]==='"'){ value+='"'; index++; }
    else if(char==='"') quoted=!quoted;
    else if(char===delimiter&&!quoted){ row.push(value); value=''; }
    else if((char==='\n'||char==='\r')&&!quoted){ if(char==='\r'&&text[index+1]==='\n') index++; row.push(value); if(row.some(cell=>String(cell).trim())) table.push(row); row=[]; value=''; }
    else value+=char;
  }
  if(value||row.length){ row.push(value); if(row.some(cell=>String(cell).trim())) table.push(row); }
  if(table.length<2) throw AppError('Le fichier CSV ne contient aucune ligne de données.');
  const headers=table.shift().map(header=>String(header||'').trim());
  return table.map(cells=>Object.fromEntries(headers.map((header,index)=>[header,cells[index]??''])));
}
function detectDataRowsType(rows){
  const headers=new Set(Object.keys(rows[0]||{}).map(normalizeExcelHeader));
  const students=headers.has('matricule')||headers.has('numeroinscription')||headers.has('anneebac')||(headers.has('nom')&&headers.has('prenom'));
  const complaints=headers.has('description')||headers.has('declaredbyname')||headers.has('datedeclaration');
  if(students===complaints) throw AppError('Impossible de déterminer si le fichier contient des étudiants ou des réclamations.');
  return students?'students':'complaints';
}
function importEnumValue(value,options,fallback){
  const normalized=normalizeExcelHeader(value);
  return options.find(([key,label])=>normalizeExcelHeader(key)===normalized||normalizeExcelHeader(label)===normalized)?.[0]||fallback;
}
function addImportSheet(workbook,name,rows){
  if(!Array.isArray(rows)) return;
  const headers=rows.length?[...new Set(rows.flatMap(row=>Object.keys(row||{})))]:name==='Étudiants'?['Matricule','Nom','Prénom','Faculté / Institut']:['Description'];
  const sheet=workbook.addWorksheet(name);
  sheet.addRow(headers);
  rows.forEach(row=>sheet.addRow(headers.map(header=>row[header]??'')));
}
const IMPORT_FIELDS={
  students:[
    {key:'id',column:'Identifiant',label:'Identifiant',aliases:['Identifiant','ID','id']},
    {key:'matricule',column:'Matricule',label:'Matricule',required:true,aliases:['Matricule','Matricule (n° Bac)','Student number','Registration number']},
    {key:'numeroInscription',column:'Numéro d’inscription',label:'Numéro d’inscription',aliases:['Numéro d’inscription','Numéro inscription','Numero inscription','numeroInscription']},
    {key:'anneeBac',column:'Année du Bac',label:'Année du Bac',aliases:['Année du Bac','Année Bac','Annee Bac','Baccalaureate year']},
    {key:'nom',column:'Nom',label:'Nom',required:true,aliases:['Nom','Name','Last name','Surname']},
    {key:'prenom',column:'Prénom',label:'Prénom',required:true,aliases:['Prénom','Prenom','First name','Given name']},
    {key:'bloc',column:'Bloc',label:'Bloc',aliases:['Bloc','Block']},
    {key:'dateNaissance',column:'Date de naissance',label:'Date de naissance',aliases:['Date de naissance','Date naissance','Birth date','Naissance','dateNaissance']},
    {key:'lieuNaissance',column:'Lieu de naissance',label:'Lieu de naissance',aliases:['Lieu de naissance','Lieu naissance','Birth place']},
    {key:'sexe',column:'Sexe',label:'Sexe',aliases:['Sexe','Sex','Gender']},
    {key:'nationalite',column:'Nationalité',label:'Nationalité',aliases:['Nationalité','Nationalite','Nationality']},
    {key:'filiere',column:'Filière',label:'Filière',aliases:['Filière','Filiere','Study field']},
    {key:'faculte',column:'Faculté / Institut',label:'Faculté / Institut',aliases:['Faculté / Institut','Faculté','Faculte','Faculty','Institute']},
    {key:'niveau',column:'Niveau',label:'Niveau',aliases:['Niveau','Niveau d’étude','Niveau étude','Study level']},
    {key:'telephone',column:'Téléphone',label:'Téléphone',aliases:['Téléphone','Telephone','Phone']},
    {key:'email',column:'Email',label:'Email',aliases:['Email','Courriel']},
    {key:'rue',column:'Rue',label:'Rue',aliases:['Rue','Street']},
    {key:'commune',column:'Commune',label:'Commune',aliases:['Commune','City']},
    {key:'wilaya',column:'Wilaya',label:'Wilaya',aliases:['Wilaya','Province']},
    {key:'statut',column:'Statut',label:'Statut',aliases:['Statut','Status']},
    {key:'chambreId',column:'ID chambre',label:'Chambre / ID chambre',aliases:['ID chambre','Chambre ID','Room ID','chambreId','Chambre','Room']}
  ],
  complaints:[
    {key:'id',column:'Identifiant',label:'Identifiant',aliases:['Identifiant','ID','id']},
    {key:'roomId',column:'ID chambre',label:'ID chambre',aliases:['ID chambre','Chambre ID','Room ID','roomId']},
    {key:'roomLabel',column:'Chambre',label:'Chambre',aliases:['Chambre','Room','roomLabel']},
    {key:'bloc',column:'Bloc',label:'Bloc',aliases:['Bloc','Block']},
    {key:'type',column:'Type',label:'Type',aliases:['Type','Category']},
    {key:'description',column:'Description',label:'Description',required:true,aliases:['Description','Details','Complaint']},
    {key:'priorite',column:'Priorité',label:'Priorité',aliases:['Priorité','Priorite','Priority']},
    {key:'statut',column:'Statut',label:'Statut',aliases:['Statut','Status']},
    {key:'declaredByType',column:'Type déclarant',label:'Type déclarant',aliases:['Type déclarant','Type declarant','Declared by type']},
    {key:'declaredByName',column:'Déclaré par',label:'Déclaré par',aliases:['Déclaré par','Déclarée par','Declared by','declaredByName']},
    {key:'declaredAt',column:'Date de déclaration',label:'Date de déclaration',aliases:['Date de déclaration','Déclaré le','Declared at','Le','declaredAt']},
    {key:'assignedToName',column:'Assignée à',label:'Assignée à',aliases:['Assignée à','Assignee','assignedToName']},
    {key:'resolvedAt',column:'Date de résolution',label:'Date de résolution',aliases:['Date de résolution','Résolue le','Resolved at','resolvedAt']}
  ]
};
function guessImportTableType(name,rows){
  const normalized=normalizeExcelHeader(name);
  if(normalized.includes('reclamation')||normalized.includes('complaint')) return 'complaints';
  if(normalized.includes('etudiant')||normalized.includes('student')) return 'students';
  try { return detectDataRowsType(rows); } catch { return 'students'; }
}
function autoMapImportHeaders(headers,type){
  const used=new Set(), mapping={};
  IMPORT_FIELDS[type].forEach(field=>{
    const aliases=field.aliases.map(normalizeExcelHeader);
    const header=headers.find(candidate=>!used.has(candidate)&&aliases.includes(normalizeExcelHeader(candidate)));
    if(header){ mapping[header]=field.key; used.add(header); }
  });
  return mapping;
}
function importMappingTableMarkup(table,index){
  const fields=IMPORT_FIELDS[table.type];
  const mapping=table.mapping||autoMapImportHeaders(table.headers,table.type);
  table.mapping=mapping;
  return `<section class="import-map-table" data-import-table="${index}" style="border:1px solid var(--line);border-radius:8px;margin-bottom:14px;overflow:hidden"><div style="display:flex;align-items:center;gap:12px;padding:10px 12px;background:var(--line-soft)"><b style="flex:1">${esc(table.name)}</b><label style="font-size:12px">Importer comme <select class="inp" data-import-type style="width:160px;display:inline-block;margin-left:6px"><option value="students" ${table.type==='students'?'selected':''}>Étudiants</option><option value="complaints" ${table.type==='complaints'?'selected':''}>Réclamations</option></select></label></div><div class="import-map-scroll" style="padding:4px 12px 12px"><table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr><th style="text-align:left;padding:7px 4px">Champ Hebergia</th><th style="text-align:left;padding:7px 4px">Colonne du fichier</th><th style="text-align:left;padding:7px 4px">Exemple</th></tr></thead><tbody>${table.headers.map(header=>`<tr><td style="padding:6px 4px;border-top:1px solid var(--line)"><select class="inp" data-import-source="${esc(header)}" style="padding:6px 8px;font-size:12px"><option value="">Ignorer cette colonne</option>${fields.map(field=>`<option value="${field.key}" ${mapping[header]===field.key?'selected':''}>${esc(field.label)}${field.required?' *':''}</option>`).join('')}</select></td><td style="padding:6px 4px;border-top:1px solid var(--line)">${esc(header)}</td><td style="padding:6px 4px;border-top:1px solid var(--line);color:var(--muted);max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(table.rows[0]?.[header]??'')}</td></tr>`).join('')}</tbody></table></div></section>`;
}
let importWizardState;
function startImportWizard(){ requireAdmin(); importWizardState={step:1,file:null,fileName:'',workbook:null,tables:[],mappedWorkbook:null,result:null}; showView('import'); }
function importWizardStepsMarkup(){
  return `<div class="import-steps">${[['Fichier','1'],['Associer les champs','2'],['Terminer','3']].map(([label,number],index)=>`<div class="import-step ${importWizardState.step===index+1?'active':importWizardState.step>index+1?'done':''}"><span class="import-step-number">${importWizardState.step>index+1?'✓':number}</span><span>${label}</span></div>`).join('')}</div>`;
}
function renderImportWizard(){
  const root=$('import-wizard-root');
  if(!root) return;
  if(!importWizardState) importWizardState={step:1,file:null,fileName:'',workbook:null,tables:[],mappedWorkbook:null,result:null};
  root.innerHTML=`<div class="import-wizard"><header class="import-wizard-head"><h2>Importer des données</h2><p>Importez les fiches étudiants ou réclamations depuis Excel, CSV ou JSON.</p></header>${importWizardStepsMarkup()}<div class="import-wizard-body" data-import-step-body></div><footer class="import-wizard-foot" data-import-step-footer></footer></div>`;
  renderImportWizardStep();
}
function renderImportWizardStep(){
  const root=$('import-wizard-root'), body=root.querySelector('[data-import-step-body]'), footer=root.querySelector('[data-import-step-footer]');
  root.querySelector('.import-steps').outerHTML=importWizardStepsMarkup();
  $('tb-sub').textContent=`Étape ${importWizardState.step} sur 3 · ${['Fichier','Association des champs','Terminer'][importWizardState.step-1]}`;
  if(importWizardState.step===1){
    body.innerHTML=`<h3 class="import-page-title">Étape 1 : choisir un fichier</h3><p class="import-page-copy">Sélectionnez un fichier à importer. Vous pourrez vérifier chaque colonne avant de modifier les données.</p><label class="import-upload"><input type="file" accept=".xlsx,.csv,.json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,application/json" data-import-file hidden>${Icons.out}<strong>Parcourir les fichiers</strong><span>Excel (.xlsx), CSV ou JSON. Les données ne seront pas modifiées à cette étape.</span></label>${importWizardState.fileName?`<div class="import-file-meta"><b>Fichier sélectionné :</b> ${esc(importWizardState.fileName)} · ${importWizardState.tables.length} feuille(s)</div>`:''}`;
    footer.innerHTML=`<button class="btn btn-ghost" type="button" data-import-cancel>Annuler</button><span class="spacer"></span><button class="btn btn-primary" type="button" data-import-continue ${importWizardState.workbook?'':'disabled'}>Associer les champs</button>`;
    body.querySelector('[data-import-file]').addEventListener('change',event=>{
      const file=event.target.files?.[0];
      if(!file) return;
      safe(async()=>{
        const workbook=await loadImportWorkbook(file);
        const tables=workbook.worksheets.map(sheet=>{const rows=excelRows(sheet);return {name:sheet.name,rows,headers:[...new Set(rows.flatMap(row=>Object.keys(row)))],type:guessImportTableType(sheet.name,rows)};}).filter(table=>table.rows.length&&table.headers.length);
        if(!tables.length) throw AppError('Le fichier ne contient aucune ligne à importer.');
        importWizardState.file=file;
        importWizardState.fileName=file.name;
        importWizardState.workbook=workbook;
        importWizardState.tables=tables;
        renderImportWizardStep();
      });
    });
    footer.querySelector('[data-import-cancel]').addEventListener('click',()=>showView('settings'));
    footer.querySelector('[data-import-continue]')?.addEventListener('click',()=>{importWizardState.step=2;renderImportWizardStep();});
  } else if(importWizardState.step===2){
    body.innerHTML=`<h3 class="import-page-title">Étape 2 : associer les champs</h3><p class="import-page-copy">Vérifiez les associations proposées. Les colonnes inutiles peuvent être ignorées. Les champs obligatoires sont marqués d’un *.</p><div data-import-mapping>${importWizardState.tables.map(importMappingTableMarkup).join('')}</div>`;
    footer.innerHTML=`<button class="btn btn-ghost" type="button" data-import-back>Retour au fichier</button><span class="spacer"></span><button class="btn btn-primary" type="button" data-import-review>Vérifier l’import</button>`;
    const mapRoot=body.querySelector('[data-import-mapping]');
    mapRoot.addEventListener('change',event=>{
      const section=event.target.closest('[data-import-table]');
      if(!section) return;
      const table=importWizardState.tables[Number(section.dataset.importTable)];
      if(event.target.matches('[data-import-type]')){
        table.type=event.target.value;
        table.mapping=autoMapImportHeaders(table.headers,table.type);
        renderImportWizardStep();
      } else if(event.target.matches('[data-import-source]')) table.mapping[event.target.dataset.importSource]=event.target.value;
    });
    footer.querySelector('[data-import-back]').addEventListener('click',()=>{importWizardState.step=1;renderImportWizardStep();});
    footer.querySelector('[data-import-review]').addEventListener('click',()=>safe(async()=>{
      const mapped={students:[],complaints:[]};
      importWizardState.tables.forEach((table,index)=>{
        const section=mapRoot.querySelector(`[data-import-table="${index}"]`);
        table.type=section.querySelector('[data-import-type]').value;
        table.mapping={};
        section.querySelectorAll('[data-import-source]').forEach(select=>{if(select.value)table.mapping[select.dataset.importSource]=select.value;});
        const fields=IMPORT_FIELDS[table.type], selected=Object.values(table.mapping);
        if(new Set(selected).size!==selected.length) throw AppError(`La feuille « ${table.name} » associe plusieurs colonnes au même champ.`);
        const missing=fields.filter(field=>field.required&&!selected.includes(field.key));
        if(missing.length) throw AppError(`Dans « ${table.name} », associez les champs obligatoires : ${missing.map(field=>field.label).join(', ')}.`);
        table.rows.forEach(row=>{
          const mappedRow={};
          Object.entries(table.mapping).forEach(([source,key])=>{const field=fields.find(item=>item.key===key);if(field)mappedRow[field.column]=row[source]??'';});
          mapped[table.type].push(mappedRow);
        });
      });
      if(!mapped.students.length&&!mapped.complaints.length) throw AppError('Aucune colonne n’est associée à un champ importable.');
      const ExcelJS=window.ExcelJS||await window.loadExcelJS?.();
      if(!ExcelJS) throw AppError('Le module Excel est indisponible.');
      const workbook=new ExcelJS.Workbook();
      if(mapped.students.length)addImportSheet(workbook,'Étudiants',mapped.students);
      if(mapped.complaints.length)addImportSheet(workbook,'Réclamations',mapped.complaints);
      importWizardState.prepared=await prepareImportData(workbook);
      importWizardState.summary={students:importWizardState.prepared.replaced.includes('étudiants')?importWizardState.prepared.students.length:0,complaints:importWizardState.prepared.replaced.includes('réclamations')?importWizardState.prepared.complaints.length:0,createdRooms:importWizardState.prepared.createdRooms,expandedRooms:importWizardState.prepared.expandedRooms,addedCapacity:importWizardState.prepared.addedCapacity,replaced:importWizardState.prepared.replaced};
      importWizardState.step=3;
      renderImportWizardStep();
    }));
  } else renderImportFinishStep(body,footer);
}
function renderImportFinishStep(body,footer){
  const result=importWizardState.result, summary=importWizardState.summary||{students:0,complaints:0,createdRooms:0,expandedRooms:0,addedCapacity:0,replaced:[]};
  if(result){
    body.innerHTML=`<div class="import-finish"><div class="import-finish-mark">${Icons.check}</div><h3>Importation terminée</h3><p>Les données du fichier ont été importées. Vous pouvez revenir à l’application.</p><div class="import-summary">${summary.students?`<div class="import-summary-item"><strong>${summary.students}</strong><span>étudiants importés</span></div>`:''}${summary.complaints?`<div class="import-summary-item"><strong>${summary.complaints}</strong><span>réclamations importées</span></div>`:''}${summary.createdRooms?`<div class="import-summary-item"><strong>${summary.createdRooms}</strong><span>chambres créées</span></div>`:''}${summary.expandedRooms?`<div class="import-summary-item"><strong>${summary.expandedRooms}</strong><span>chambres agrandies de ${summary.addedCapacity} place(s)</span></div>`:''}</div></div>`;
    footer.innerHTML=`<span class="spacer"></span><button class="btn btn-primary" type="button" data-import-done>Terminer</button>`;
    footer.querySelector('[data-import-done]').addEventListener('click',()=>showView('dashboard'));
    return;
  }
  const studentLabel=summary.students===1?'étudiant à importer':'étudiants à importer';
  const complaintLabel=summary.complaints===1?'réclamation à importer':'réclamations à importer';
  body.innerHTML=`<h3 class="import-page-title">Étape 3 : terminer l’importation</h3><p class="import-page-copy">Vérifiez le récapitulatif. Aucune donnée n’a encore été modifiée.</p><div class="import-file-meta"><b>Fichier :</b> ${esc(importWizardState.fileName)}<br><b>Type :</b> ${summary.replaced.map(kind=>kind==='étudiants'?'Étudiants':'Réclamations').join(' et ')||'Aucun champ détecté'}</div><div class="import-summary">${summary.students?`<div class="import-summary-item"><strong>${summary.students}</strong><span>${studentLabel}</span></div>`:''}${summary.complaints?`<div class="import-summary-item"><strong>${summary.complaints}</strong><span>${complaintLabel}</span></div>`:''}${summary.createdRooms?`<div class="import-summary-item"><strong>${summary.createdRooms}</strong><span>chambres à créer</span></div>`:''}${summary.expandedRooms?`<div class="import-summary-item"><strong>${summary.expandedRooms}</strong><span>chambres à agrandir de ${summary.addedCapacity} place(s)</span></div>`:''}</div><div class="import-file-meta" style="border-color:var(--warn);background:var(--warn-bg)"><b>Attention :</b> ${summary.replaced.map(kind=>kind==='étudiants'?'les étudiants':'les réclamations').join(' et ')} actuels seront remplacés. Les chambres manquantes seront créées et la capacité des chambres trop petites sera augmentée. Les autres données resteront intactes.</div>`;
  footer.innerHTML=`<button class="btn btn-ghost" type="button" data-import-back>Retour au mapping</button><span class="spacer"></span><button class="btn btn-primary" type="button" data-import-finish>Importer les données</button>`;
  footer.querySelector('[data-import-back]').addEventListener('click',()=>{importWizardState.step=2;renderImportWizardStep();});
  footer.querySelector('[data-import-finish]').addEventListener('click',()=>safe(async()=>{
    const prepared=importWizardState.prepared;
    await Store.replaceAll({...prepared.snap,students:prepared.students,complaints:prepared.complaints});
    importWizardState.result='success';
    renderImportWizardStep();
    toast('Données importées.','success');
  }));
}
async function prepareImportData(workbook){
  const studentsSheet=workbook.worksheets.find(sheet=>['etudiants','students'].includes(normalizeExcelHeader(sheet.name)));
  const complaintsSheet=workbook.worksheets.find(sheet=>['reclamations','complaints'].includes(normalizeExcelHeader(sheet.name)));
  const studentsName=studentsSheet?.name, complaintsName=complaintsSheet?.name;
  if(!studentsName&&!complaintsName) throw AppError('Le classeur doit contenir une feuille Étudiants ou Réclamations.');
  const snap=await snapshot();
  let students=snap.students, complaints=snap.complaints;
  const rooms=[...snap.rooms], blocks=[...snap.blocks], floors=[...snap.floors];
  const createdRooms=new Set(), originalRoomCapacities=new Map();
  const normalizeBlockName=value=>normalizeExcelHeader(String(value??'').replace(/^\s*bloc\s*/i,''));
  const resolveBlockName=value=>{
    const key=normalizeBlockName(value);
    if(!key) return '';
    const existing=[...blocks.map(block=>block.name),...rooms.map(room=>room.bloc)].find(name=>normalizeBlockName(name)===key);
    if(existing) return existing;
    const name=/^\s*bloc\b/i.test(String(value))?String(value).trim():`Bloc ${String(value).trim()}`;
    blocks.push({id:uid(),name,ordre:blocks.length,genre:'mixte'});
    return name;
  };
  const roomNumberFromValue=value=>{
    const match=excelText(value).match(/(\d{1,3})\s*$/);
    return match?match[1].padStart(3,'0'):'';
  };
  const resolveImportRoom=(roomValue,blockValue)=>{
    const value=excelText(roomValue);
    if(!value) return null;
    const blockName=resolveBlockName(blockValue);
    const blockKey=normalizeBlockName(blockName);
    const number=roomNumberFromValue(value);
    const directMatches=rooms.filter(room=>room.id===value||normalizeExcelHeader(roomLabel(room))===normalizeExcelHeader(value));
    if(directMatches.length){
      const matches=blockKey?directMatches.filter(room=>normalizeBlockName(room.bloc)===blockKey):directMatches;
      if(matches.length>1) throw AppError(`La chambre « ${value} » est ambiguë. Associez la colonne Bloc.`);
      if(!matches.length) throw AppError(`La chambre « ${value} » ne correspond pas au bloc ${blockName}.`);
      return matches[0];
    }
    const matches=rooms.filter(room=>{
      const blockMatches=!blockKey||normalizeBlockName(room.bloc)===blockKey;
      return blockMatches&&(String(room.numero)===value||(number&&String(room.numero)===number));
    });
    if(!blockKey){
      if(matches.length>1) throw AppError(`La chambre « ${value} » existe dans plusieurs blocs. Associez aussi la colonne Bloc.`);
      if(matches.length===1) return matches[0];
      throw AppError(`La chambre « ${value} » n’existe pas. Associez une colonne Bloc pour pouvoir la créer.`);
    }
    if(matches.length>1) throw AppError(`La chambre « ${value} » est ambiguë dans le bloc ${blockName}.`);
    if(matches.length===1) return matches[0];
    if(!number) throw AppError(`Le numéro de chambre « ${value} » est invalide. Utilisez un numéro de 1 à 3 chiffres.`);
    const room={id:uid(),bloc:blockName,numero:number,capacite:2,statut:'normal'};
    rooms.push(room);
    createdRooms.add(room.id);
    const floor=parseInt(number.slice(0,-2),10)||0;
    if(!floors.some(item=>normalizeBlockName(item.bloc)===blockKey&&item.numero===floor)) floors.push({id:uid(),bloc:blockName,numero:floor});
    return room;
  };
  if(studentsName){
    const rows=excelRows(studentsSheet);
    const existingByMatricule=new Map(snap.students.map(student=>[excelText(student.matricule).toLowerCase(),student]));
    students=rows.map(row=>{
      const matricule=excelText(excelValue(row,['Matricule','Matricule (n° Bac)']));
      const nom=excelText(excelValue(row,['Nom','Name']));
      const prenom=excelText(excelValue(row,['Prénom','Prenom','First name']));
      const faculte=excelText(excelValue(row,['Faculté / Institut','Faculté','Faculte','Faculty','Institute']));
      if(!matricule||!nom||!prenom) throw AppError('Chaque étudiant Excel doit avoir un matricule, un nom et un prénom.');
      const matriculeKey=matricule.toLowerCase();
      const existing=existingByMatricule.get(matriculeKey);
      const rawYear=Number(excelValue(row,['Année du Bac','Année Bac','Annee Bac']));
      const anneeBac=Number.isInteger(rawYear)&&rawYear>0?rawYear:(Number(matricule.slice(0,4))||2025);
      const readText=(aliases,previous='')=>{
        const value=excelValue(row,aliases);
        return value===undefined?previous:excelText(value);
      };
      const rawStatus=readText(['Statut','Status'],existing?.statut||'actif').toLowerCase();
      const roomValue=excelValue(row,['ID chambre','Chambre ID','Room ID','chambreId','Chambre','Chambre / ID chambre']);
      const blockValue=excelValue(row,['Bloc','Block']);
      const numeroInscription=readText(['Numéro d’inscription','Numéro inscription','Numero inscription','Numero d inscription'],`${anneeBac}${matricule}`);
      const room=roomValue===undefined?null:resolveImportRoom(roomValue,blockValue);
      const sexe=readText(['Sexe','Sex','Gender'],existing?.sexe||'');
      const statut=['sorti','sortie','inactive'].includes(rawStatus)?'sorti':'actif';
      if(statut==='actif') assertResidenceGenderCompatible({sexe,prenom,nom});
      if(statut==='actif'&&room) assertBlockGenderCompatible({blocks,rooms},{sexe,prenom,nom},room);
      const chambreId=roomValue===undefined?(existing?.chambreId||null):(room?.id||null);
      if(statut==='actif'&&room?.statut==='hors_service') throw AppError(`Impossible d’affecter ${prenom} ${nom} : la chambre ${roomLabel(room)} est hors service.`);
      return {
        id:readText(['Identifiant','ID'],existing?.id||uid()),matricule,numeroInscription,anneeBac,nom,prenom,
        sexe,
        nationalite:readText(['Nationalité','Nationalite','Nationality'],existing?.nationalite||''),
        dateNaissance:excelDate(excelValue(row,['Date de naissance','Date naissance','Birth date','Naissance','dateNaissance'])),
        lieuNaissance:readText(['Lieu de naissance','Lieu naissance','Birth place'],existing?.lieuNaissance||''),
        filiere:readText(['Filière','Filiere','Study field'],existing?.filiere||''),faculte,
        niveau:readText(['Niveau','Niveau d’étude','Niveau étude','Study level'],existing?.niveau||'L1'),
        telephone:readText(['Téléphone','Telephone','Phone'],existing?.telephone||''),
        email:readText(['Email','Courriel'],existing?.email||''),rue:readText(['Rue','Street'],existing?.rue||''),
        commune:readText(['Commune'],existing?.commune||''),wilaya:readText(['Wilaya'],existing?.wilaya||''),
        statut,chambreId
      };
    });
    for(const room of rooms){
      const occupancy=students.filter(student=>student.statut==='actif'&&student.chambreId===room.id).length;
      if(occupancy>room.capacite){
        originalRoomCapacities.set(room.id,room.capacite);
        room.capacite=occupancy;
      }
    }
  }
  if(complaintsName){
    const rows=excelRows(complaintsSheet);
    complaints=rows.map(row=>{
      const roomId=excelText(excelValue(row,['ID chambre','Chambre ID','Room ID','roomId']));
      const roomLabelValue=excelText(excelValue(row,['Chambre','Room','roomLabel']));
      const room=snap.rooms.find(item=>item.id===roomId||roomLabel(item)===roomLabelValue);
      const declaredAt=excelDate(excelValue(row,['Date de déclaration','Déclaré le','Declared at','Le']),true)||nowISO();
      const resolved=excelValue(row,['Date de résolution','Résolue le','Resolved at']);
      return {
        id:excelText(excelValue(row,['Identifiant','ID']))||uid(),roomId:roomId||room?.id||'',
        roomLabel:roomLabelValue||(room?roomLabel(room):''),bloc:excelText(excelValue(row,['Bloc']))||room?.bloc||'',
        type:importEnumValue(excelValue(row,['Type']),TYPES_REC,'autre'),description:excelText(excelValue(row,['Description'])),
        priorite:importEnumValue(excelValue(row,['Priorité','Priorite','Priority']),PRIORITES,'basse'),
        statut:importEnumValue(excelValue(row,['Statut','Status']),REC_STATUTS,'nouvelle'),
        declaredByType:excelText(excelValue(row,['Type déclarant','Type declarant','Declared by type']))||'agent',
        declaredByName:excelText(excelValue(row,['Déclaré par','Déclarée par','Declared by']))||'',declaredAt,
        assignedToName:excelText(excelValue(row,['Assignée à','Assignee','assignedToName']))||null,
        resolvedAt:resolved?excelDate(resolved,true):null
      };
    });
  }
  const replaced=[];
  if(studentsName) replaced.push('étudiants');
  if(complaintsName) replaced.push('réclamations');
  return {snap:{...snap,rooms,blocks,floors},students,complaints,replaced,createdRooms:createdRooms.size,expandedRooms:originalRoomCapacities.size,addedCapacity:[...originalRoomCapacities].reduce((total,[id,capacity])=>total+(rooms.find(room=>room.id===id)?.capacite||capacity)-capacity,0)};
}
async function loadImportWorkbook(file){
  const extension=file.name.toLowerCase().split('.').pop();
  const ExcelJS=window.ExcelJS || await window.loadExcelJS?.();
  if(!ExcelJS) throw AppError('Le module Excel est indisponible.');

  if(extension==='xlsx' || extension==='xls'){
    const workbook=new ExcelJS.Workbook();
    const arrayBuffer=await file.arrayBuffer();
    await workbook.xlsx.load(arrayBuffer);
    return workbook;
  }

  const workbook=new ExcelJS.Workbook();
  if(extension==='csv'){
    const rows=parseCSVRows(await file.text());
    let sheetName='Données';
    try { sheetName=detectDataRowsType(rows)==='students'?'Étudiants':'Réclamations'; } catch {}
    addImportSheet(workbook,sheetName,rows);
    return workbook;
  }

  if(extension==='json'){
    const parsed=JSON.parse(await file.text()), data=parsed?.data??parsed;
    if(data&&['users','rooms','history','blocks','floors'].every(key=>Array.isArray(data[key]))) throw AppError('Ce fichier est une sauvegarde complète. Utilisez « Import backup » pour la restaurer.');
    let studentsRows=Array.isArray(data?.students)?data.students:null;
    let complaintsRows=Array.isArray(data?.complaints)?data.complaints:null;
    let genericRows=null;
    if(Array.isArray(data)){
      try { if(detectDataRowsType(data)==='students') studentsRows=data; else complaintsRows=data; }
      catch { genericRows=data; }
    }
    if(!studentsRows&&!complaintsRows&&!genericRows) throw AppError('Le fichier JSON doit contenir une liste students, complaints ou une liste de données.');
    if(genericRows) addImportSheet(workbook,'Données',genericRows);
    else { addImportSheet(workbook,'Étudiants',studentsRows); addImportSheet(workbook,'Réclamations',complaintsRows); }
    return workbook;
  }

  throw AppError('Choisissez un fichier Excel (.xlsx), CSV (.csv) ou JSON (.json).');
}

/* ══════════════ SECTION 16 — CONNEXION / DÉCONNEXION ══════════════ */
function enterApp(user){
  Session.user = user;
  sessionStorage.setItem('hg_session', user.id);
  $('login').hidden = true;
  $('app').hidden = false;
  applyPreferences();
  document.querySelectorAll('.brand-sub').forEach(el=>el.textContent=localStorage.getItem('hebergia_establishment')||el.textContent);
  /* Badge rôle + bloc (exigence UX) */
  setUserAvatar($('chip-avatar'), user);
  $('chip-name').textContent = user.name;
  $('chip-role').textContent = user.role==='admin'?'Administrateur':'Utilisateur';
  $('nav-history').hidden = !isAdmin();
  if ($('btn-reset')) $('btn-reset').hidden = true;
  $('tb-date').textContent = new Date().toLocaleDateString('fr-FR',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  showView(localStorage.getItem('hebergia_start_page') || 'dashboard');
}
function logout(){
  sessionStorage.removeItem('hg_session');
  Session.user = null;
  $('app').hidden = true;
  $('login').hidden = false;
  $('lg-pass').value = '';
}
function toggleProfileMenu(){ const menu=$('profile-menu'); if(menu) menu.hidden=!menu.hidden; }
function closeProfileMenu(){ const menu=$('profile-menu'); if(menu) menu.hidden=true; }
function openAboutApp(){
  closeProfileMenu();
  const establishment=esc(localStorage.getItem('hebergia_establishment')||'Résidence universitaire Pepiniere');
  const version='1.0.0';
  const aboutModal=Modal.open({title:'À propos de Hebergia',wide:true,className:'about-modal',hideHeader:true,body:`
    <div class="about-hero"><img alt="Logo Hebergia"><div><h2>HEBERGIA</h2><p>Gestion de l’hébergement universitaire</p><span class="about-version">VERSION ${version}</span></div></div>
    <div class="about-content"><section><h3>À propos de l’application</h3><p class="about-description">Hebergia accompagne la gestion quotidienne d’une résidence universitaire : dossiers des résidents, répartition des chambres, suivi des mouvements, réclamations et rapports. Les données sont conservées localement sur cet ordinateur.</p></section>
      <section><h3 style="margin-top:20px">Fonctionnalités</h3><div class="about-features">
        <article class="about-feature"><span class="about-feature-icon">${Icons.users}</span><div><h4>Résidents</h4><p>Fiches, recherche, statut et affectations en chambre.</p></div></article>
        <article class="about-feature"><span class="about-feature-icon">${Icons.bed}</span><div><h4>Chambres et blocs</h4><p>Capacité, disponibilité et organisation par étage.</p></div></article>
        <article class="about-feature"><span class="about-feature-icon">${Icons.clock}</span><div><h4>Historique des affectations</h4><p>Suivi des entrées, sorties et transferts par année universitaire.</p></div></article>
        <article class="about-feature"><span class="about-feature-icon">${Icons.download}</span><div><h4>Réclamations et rapports</h4><p>Suivi des incidents, indicateurs et exports Excel, CSV ou JSON.</p></div></article>
      </div></section>
      <section class="about-developer"><h3>Développeur</h3><div class="about-developer-profile">
        <span class="about-developer-avatar" aria-hidden="true">AS</span>
        <div><h4 class="about-developer-name">ABDULKARIM SEIDI</h4>
          <p class="about-developer-bio">Abdelkarim Seidi s’intéresse à la technologie, à la transformation numérique et au développement de solutions logicielles pratiques. Il associe son expérience en communication institutionnelle à sa passion pour le développement d’applications afin de simplifier le travail, améliorer la gestion de l’information et créer des outils numériques modernes adaptés aux utilisateurs.</p>
        </div>
      </div></section>
    </div><footer class="about-footer"><span>© ${new Date().getFullYear()} · ${establishment}</span><span>Hebergia · Version ${version}</span></footer>`});
  const loginLogo=document.querySelector('.login-card-brand');
  if(loginLogo?.src) aboutModal.root.querySelector('.about-hero img').src=loginLogo.src;
}
const APP_THEMES={
  hebergia:{bg:'#eef5f6',surface:'#ffffff',line:'#d7e4e6',lineSoft:'#eaf1f2',ink:'#102d35',muted:'#657b80',brand:'#146b72',brand2:'#0d4f5a',gold:'#f39a2f',goldSoft:'#fff0d8',sidebar:'#083d47',sidebar2:'#062c35'},
  blue:{bg:'#eef4fa',surface:'#ffffff',line:'#d8e3ee',lineSoft:'#edf3f8',ink:'#142b40',muted:'#64798b',brand:'#2169a5',brand2:'#174c7b',gold:'#eea33b',goldSoft:'#fff1d9',sidebar:'#123b63',sidebar2:'#0b2b4a'},
  green:{bg:'#eef6f1',surface:'#ffffff',line:'#d7e7de',lineSoft:'#ecf5ef',ink:'#12352c',muted:'#668078',brand:'#16805f',brand2:'#0d5b46',gold:'#e9a33b',goldSoft:'#fff1d5',sidebar:'#0a4437',sidebar2:'#062e26'},
  orange:{bg:'#fff5ec',surface:'#ffffff',line:'#eadfd4',lineSoft:'#f7eee6',ink:'#3d2a20',muted:'#897368',brand:'#d66d2d',brand2:'#a94c1e',gold:'#f2a51f',goldSoft:'#fff0d2',sidebar:'#61321f',sidebar2:'#3f2118'},
  plum:{bg:'#f6f1f8',surface:'#ffffff',line:'#e5d9e9',lineSoft:'#f2eaf4',ink:'#302339',muted:'#7b6b82',brand:'#79508c',brand2:'#5b396b',gold:'#d5a153',goldSoft:'#f9edd9',sidebar:'#42294f',sidebar2:'#2b1b35'},
  slate:{bg:'#f1f5f7',surface:'#ffffff',line:'#dbe4e8',lineSoft:'#edf2f4',ink:'#20313a',muted:'#6c7d85',brand:'#3f6170',brand2:'#2d4652',gold:'#b7a365',goldSoft:'#f5efd9',sidebar:'#263e49',sidebar2:'#1b2d35'}
};
function applyPreferences(){
  const mode=localStorage.getItem('hebergia_mode')||'light';
  document.body.classList.toggle('motion-disabled',localStorage.getItem('hebergia_motion')==='0');
  document.body.classList.toggle('residence-single-sex',residenceGenderType()!=='mixte');
  let themeKey=localStorage.getItem('hebergia_theme');
  if(!themeKey||themeKey==='forest'){ themeKey='hebergia'; localStorage.setItem('hebergia_theme',themeKey); }
  const theme=APP_THEMES[themeKey]||APP_THEMES.hebergia;
  document.body.classList.toggle('dark-mode',mode==='dark');
  ['bg','surface','line','lineSoft','ink','muted','brand','brand2','gold','goldSoft','sidebar','sidebar2'].forEach(key=>{ const cssKey={brand2:'brand-2',sidebar2:'sidebar-2'}[key]||key.replace(/[A-Z]/g,m=>'-'+m.toLowerCase()); document.documentElement.style.setProperty('--'+cssKey,theme[key]); });
  document.documentElement.style.setProperty('--text-scale',localStorage.getItem('hebergia_text_size')==='small'?'0.92':localStorage.getItem('hebergia_text_size')==='big'?'1.1':'1');
  document.documentElement.style.setProperty('--font-display',localStorage.getItem('hebergia_title_font')||'Bahnschrift');
  document.documentElement.style.setProperty('--font-body',localStorage.getItem('hebergia_body_font')||'Segoe UI');
  updateThemeToggle();
}
function updateThemeToggle(){ const button=$('tb-theme-toggle'); if(!button) return; const dark=document.body.classList.contains('dark-mode'); button.innerHTML=`<span class="material-symbols-outlined" aria-hidden="true">${dark?'light_mode':'dark_mode'}</span>`; button.title=dark?'Passer en mode clair':'Passer en mode sombre'; button.setAttribute('aria-label',button.title); }
function toggleTheme(){ const dark=document.body.classList.contains('dark-mode'); localStorage.setItem('hebergia_mode',dark?'light':'dark'); applyPreferences(); if(currentView==='dashboard') safe(renderDashboard); }
function renderSettings(){
  const root=$('settings-page-root'); if(!root) return;
  root.innerHTML=`<div class="settings-page"><div class="settings-page-head"><div><h2>Settings</h2><p>Préférences de l’application</p></div><span class="spacer"></span><button class="btn btn-primary" data-settings-save>Save settings</button></div><div class="settings-layout">
    <nav class="settings-nav" aria-label="Settings sections"><button class="settings-tab active" data-settings-page-tab="general">General</button><button class="settings-tab" data-settings-page-tab="appearance">Appearance</button><button class="settings-tab" data-settings-page-tab="data">Data and Backups</button><button class="settings-tab" data-settings-page-tab="templates">Modèles de documents</button>${isAdmin()?'<button class="settings-tab" data-settings-page-tab="users">Users manager</button>':''}</nav>
    <div class="settings-content"><section class="settings-panel" data-settings-page-panel="general"><h4>General</h4><p class="settings-lead">Basic application preferences.</p><div class="field"><label>Direction Universitaire</label><input class="inp" name="universityDirection" value="${esc(localStorage.getItem('hebergia_university_direction')||'')}"></div><div class="field" style="margin-top:14px"><label>Résidence Universitaire</label><input class="inp" name="establishment" value="${esc(localStorage.getItem('hebergia_establishment')||'Résidence universitaire Pepiniere')}"></div><div class="field" style="margin-top:14px"><label>Type de résidence</label><select class="inp" name="residenceType"><option value="garcon">Garçons</option><option value="fille">Filles</option><option value="mixte">Mixte</option></select></div><div class="field" style="margin-top:14px"><label>Start page</label><select class="inp" name="startPage"><option value="dashboard">Tableau de bord</option><option value="rooms">Chambres</option><option value="students">Étudiants</option></select></div><div class="field" style="margin-top:14px"><label>Dossier des photos des résidents</label><div style="display:flex;align-items:center;gap:8px"><input class="inp" name="studentPhotoDirectory" readonly placeholder="Aucun dossier sélectionné" style="min-width:0;flex:1"><button class="btn btn-ghost" type="button" data-choose-student-photo-directory>Choisir un dossier</button></div><div style="font-size:11px;color:var(--muted);margin-top:5px">À l’enregistrement, chaque photo est automatiquement nommée avec le numéro d’inscription (Année du Bac + Matricule).webp, puis enregistrée dans ce dossier.</div></div></section>
      <section class="settings-panel" data-settings-page-panel="templates" hidden><h4>Modèles de documents</h4><p class="settings-lead">Gérez les attestations et convocations, ou ajoutez d’autres types de documents avec leurs propres modèles.</p><div data-document-templates-list></div></section>
      <section class="settings-panel" data-settings-page-panel="appearance" hidden><h4>Appearance</h4><p class="settings-lead">Customize the visual identity and reading comfort.</p><div class="field"><label>Mode</label><select class="inp" name="mode"><option value="light">Light mode</option><option value="dark">Dark mode</option></select></div><div class="field" style="margin-top:14px"><label>Theme</label><select class="inp" name="theme"><option value="hebergia">Hebergia Blue · Green · Orange</option><option value="blue">Classic Blue</option><option value="green">Fresh Green</option><option value="orange">Warm Orange</option><option value="plum">Plum Modern</option><option value="slate">Slate Professional</option></select></div><div class="field" style="margin-top:14px"><label>Title font</label><select class="inp" name="titleFont"><option value="Bahnschrift">Bahnschrift</option><option value="'Roboto Slab', Georgia, serif">Roboto Slab</option><option value="Montserrat, Arial, sans-serif">Montserrat</option><option value="Poppins, Arial, sans-serif">Poppins</option><option value="'Lato', Arial, sans-serif">Lato</option><option value="Georgia, serif">Georgia</option><option value="Garamond, serif">Garamond</option><option value="'Times New Roman', serif">Times New Roman</option></select></div><div class="field" style="margin-top:14px"><label>Text font</label><select class="inp" name="bodyFont"><option value="Segoe UI">Segoe UI</option><option value="'Open Sans', Arial, sans-serif">Open Sans</option><option value="'Lato', Arial, sans-serif">Lato</option><option value="Montserrat, Arial, sans-serif">Montserrat</option><option value="Poppins, Arial, sans-serif">Poppins</option><option value="Arial">Arial</option><option value="Verdana">Verdana</option><option value="Tahoma">Tahoma</option></select></div><div class="field" style="margin-top:14px"><label>Text size</label><select class="inp" name="textSize"><option value="small">Small</option><option value="normal">Normal</option><option value="big">Big</option></select></div><label style="display:flex;align-items:center;gap:9px;text-transform:none;letter-spacing:0;margin-top:16px"><input type="checkbox" name="compact" style="width:16px;height:16px"> Compact room and Bloc cards</label><label style="display:flex;align-items:center;gap:9px;text-transform:none;letter-spacing:0;margin-top:12px"><input type="checkbox" name="motion" style="width:16px;height:16px"> Use interface animations</label></section>
      <section class="settings-panel" data-settings-page-panel="data" hidden><h4>Data and Backups</h4><p class="settings-lead">Import, export, and protect the data stored on this computer.</p><div class="card" style="margin:0 0 12px"><div class="card-b"><b>Import / Export data</b><div style="font-size:12px;color:var(--muted);margin:5px 0 14px">Students and complaints only. Excel is the default format; CSV and JSON are also available.</div><div style="display:flex;gap:8px;flex-wrap:wrap"><details class="settings-dropdown"><summary class="btn btn-primary">Import</summary><div class="settings-menu"><label class="settings-menu-item">Excel (.xls / .xlsx)<input type="file" accept=".xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" data-settings-data-import="excel" hidden></label><label class="settings-menu-item">CSV<input type="file" accept=".csv,text/csv" data-settings-data-import="csv" hidden></label><label class="settings-menu-item">JSON<input type="file" accept="application/json,.json" data-settings-data-import="json" hidden></label></div></details><details class="settings-dropdown"><summary class="btn btn-ghost">Export</summary><div class="settings-menu"><button class="settings-menu-item" type="button" data-settings-data-export="excel">Excel (.xls)</button><button class="settings-menu-item" type="button" data-settings-data-export="csv">CSV</button><button class="settings-menu-item" type="button" data-settings-data-export="json">JSON</button></div></details></div></div></div><div class="card" style="margin:0 0 12px"><div class="card-b"><b>Backups</b><div style="font-size:12px;color:var(--muted);margin:5px 0 14px">Create or restore a portable JSON backup before reinstalling or moving the application.</div><div style="font-size:11px;color:var(--muted);margin:-5px 0 14px">Backups include residents, user accounts, rooms, renewals, complaints, and history. Accounts not yet signed in since password protection was added may still have plaintext passwords in the backup; keep it secure. Separate photo files are not included; maximum restore file size is 100 MB.</div><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-ghost" type="button" data-settings-backup>${Icons.download} Export backup</button><label class="btn btn-ghost">Import backup<input type="file" accept="application/json,.json" data-settings-import-backup hidden></label></div></div></div><div class="card" style="margin:0;border-color:var(--bad)"><div class="card-b"><b style="color:var(--bad)">Reset the app</b><div style="font-size:12px;color:var(--muted);margin:5px 0 14px">Permanently delete all local data and restore the initial setup.</div><button class="btn btn-danger" type="button" data-settings-reset>Reset all data</button></div></div></section>
    </div></div></div>`;
  if (isAdmin()) root.querySelector('.settings-content').insertAdjacentHTML('beforeend', `<section class="settings-panel" data-settings-page-panel="users" hidden><h4>Users manager</h4><p class="settings-lead">Manage administrators and users who can access this application.</p><div class="card" style="margin:0"><div class="card-h"><h3>Users</h3><span class="spacer"></span><button class="btn btn-primary btn-sm" data-action="new-user">+ New user</button></div><div class="card-b"><div class="cnt" id="us-count"></div><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Name</th><th>Username</th><th>Phone</th><th>Role</th><th>Status</th><th class="actions">Actions</th></tr></thead><tbody id="us-tbody"></tbody></table></div></div></div></section>`);
  const excelInput=root.querySelector('[data-settings-data-import="excel"]');
  const importMenu=excelInput?.closest('details');
  if(importMenu) importMenu.outerHTML=`<button class="btn btn-primary" type="button" data-action="open-import-wizard">Importer</button>`;
  if(!isAdmin()) root.querySelector('[data-action="open-import-wizard"]')?.setAttribute('hidden','');
  const excelExport=root.querySelector('[data-settings-data-export="excel"]');
  const settingsExportMenu=excelExport?.closest('details');
  if(settingsExportMenu) settingsExportMenu.outerHTML=exportControlMarkup('all','settings-export');
  translateRenderedUi(root);
  bindResidenceTypeSetting(root.querySelector('[name="residenceType"]'));
  const studentPhotoDirectory=root.querySelector('[name="studentPhotoDirectory"]');
  const photoApi=window.hebergia?.photos;
  let photoDirectorySelection=0;
  if(photoApi) safe(async()=>{
    const request=photoDirectorySelection;
    const directory=await photoApi.getStudentDirectory();
    if(request===photoDirectorySelection) studentPhotoDirectory.value=directory||'';
  });
  root.querySelector('[data-choose-student-photo-directory]').addEventListener('click',async()=>{
    await safe(async()=>{
      if(!photoApi) throw AppError('Le choix du dossier est disponible uniquement dans l’application de bureau.');
      const request=++photoDirectorySelection;
      const result=await photoApi.chooseStudentDirectory();
      if(result){
        studentPhotoDirectory.value=result.directory;
        localStorage.setItem('hebergia_student_photo_directory',result.directory);
        const migrationMessage=result.moved||result.skipped
          ? ` ${result.moved} élément(s) déplacé(s)${result.skipped?`, ${result.skipped} doublon(s) conservé(s) dans le dossier par défaut`:''}.`
          : '';
        toast(`Dossier des photos enregistré.${migrationMessage}`,'success');
      } else if(request===photoDirectorySelection){
        studentPhotoDirectory.value=await photoApi.getStudentDirectory()||'';
      }
    });
  });
  if (isAdmin()) renderUsers();
  if (!isAdmin()) root.querySelector('[data-settings-data-import="file"]')?.closest('label')?.setAttribute('hidden','');
  if (!isAdmin()) { const importMenu=root.querySelector('[data-settings-data-import]')?.closest('details'); if (importMenu) importMenu.hidden=true; root.querySelectorAll('[data-settings-import-backup]').forEach(input=>{ const label=input.closest('label'); if(label) label.hidden=true; }); const reset=root.querySelector('[data-settings-reset]'); if(reset) reset.closest('.card').hidden=true; }
  const importNote=root.querySelector('[data-settings-page-panel="data"] .card .card-b > div');
  if(importNote) importNote.textContent='Étudiants et réclamations uniquement. Formats acceptés : Excel (.xlsx), CSV et JSON.';
  applyPreferences(); const compact=root.querySelector('[name="compact"]'), motion=root.querySelector('[name="motion"]'), startPage=root.querySelector('[name="startPage"]'); compact.checked=localStorage.getItem('hebergia_compact')==='1'; motion.checked=localStorage.getItem('hebergia_motion')!=='0'; startPage.value=localStorage.getItem('hebergia_start_page')||'dashboard'; ['mode','theme','titleFont','bodyFont','textSize'].forEach(name=>{ const el=root.querySelector(`[name="${name}"]`); const key={mode:'hebergia_mode',theme:'hebergia_theme',titleFont:'hebergia_title_font',bodyFont:'hebergia_body_font',textSize:'hebergia_text_size'}[name]; if(localStorage.getItem(key)) el.value=localStorage.getItem(key); });
  root.querySelectorAll('[data-settings-page-tab]').forEach(tab=>tab.addEventListener('click',()=>{ root.querySelectorAll('[data-settings-page-tab]').forEach(x=>x.classList.toggle('active',x===tab)); root.querySelectorAll('[data-settings-page-panel]').forEach(panel=>panel.hidden=panel.dataset.settingsPagePanel!==tab.dataset.settingsPageTab); if(tab.dataset.settingsPageTab==='templates') safe(()=>renderDocumentTemplates(root)); }));
  root.querySelector('[data-settings-backup]').addEventListener('click',exportBackup); root.querySelectorAll('[data-settings-data-export]').forEach(button=>button.addEventListener('click',()=>({excel:exportDataExcel,csv:exportDataCSV,json:exportDataJSON}[button.dataset.settingsDataExport])())); root.querySelectorAll('[data-settings-import-backup]').forEach(input=>input.addEventListener('change',e=>{if(isAdmin()) importBackup(e)})); root.querySelector('[data-settings-reset]').addEventListener('click',()=>{if(isAdmin()) resetAppData()});
  root.querySelector('[data-settings-save]').addEventListener('click',()=>{ localStorage.setItem('hebergia_university_direction',root.querySelector('[name="universityDirection"]').value.trim()); localStorage.setItem('hebergia_establishment',root.querySelector('[name="establishment"]').value.trim()||'Résidence universitaire Pepiniere'); localStorage.setItem('hebergia_compact',compact.checked?'1':'0'); localStorage.setItem('hebergia_motion',motion.checked?'1':'0'); localStorage.setItem('hebergia_start_page',startPage.value); ['mode','theme','titleFont','bodyFont','textSize'].forEach(name=>localStorage.setItem({mode:'hebergia_mode',theme:'hebergia_theme',titleFont:'hebergia_title_font',bodyFont:'hebergia_body_font',textSize:'hebergia_text_size'}[name],root.querySelector(`[name="${name}"]`).value)); applyPreferences(); document.querySelectorAll('.brand-sub').forEach(el=>el.textContent=localStorage.getItem('hebergia_establishment')); toast('Settings saved.','success'); });
}
function openSettings(){
  closeProfileMenu();
  Modal.open({title:'Settings',sub:'Préférences de l’application',wide:true,body:`<div class="settings-layout">
    <nav class="settings-nav" aria-label="Settings sections">
      <button class="settings-tab active" data-settings-tab="general">General</button>
      <button class="settings-tab" data-settings-tab="appearance">Appearance</button>
      <button class="settings-tab" data-settings-tab="data">Data and Backups</button>
    </nav>
    <div class="settings-content">
      <section class="settings-panel" data-settings-panel="general"><h4>General</h4><p class="settings-lead">Basic application preferences.</p><div class="field"><label>Type de résidence</label><select class="inp" name="residenceType"><option value="garcon">Garçons</option><option value="fille">Filles</option><option value="mixte">Mixte</option></select></div><div class="field" style="margin-top:14px"><label>Start page</label><select class="inp" name="startPage"><option value="dashboard">Tableau de bord</option><option value="rooms">Chambres</option><option value="students">Étudiants</option></select></div></section>
      <section class="settings-panel" data-settings-panel="appearance" hidden><h4>Appearance</h4><p class="settings-lead">Adjust how information is displayed.</p><label style="display:flex;align-items:center;gap:9px;text-transform:none;letter-spacing:0;margin-bottom:14px"><input type="checkbox" name="compact" style="width:16px;height:16px"> Compact room and Bloc cards</label><label style="display:flex;align-items:center;gap:9px;text-transform:none;letter-spacing:0"><input type="checkbox" name="motion" style="width:16px;height:16px"> Use interface animations</label></section>
      <section class="settings-panel" data-settings-panel="data" hidden><h4>Data and Backups</h4><p class="settings-lead">Your data is stored locally on this computer.</p><div class="card" style="margin:0"><div class="card-b"><b>Local database</b><div style="font-size:12px;color:var(--muted);margin:5px 0 14px">Export a complete JSON backup before moving or reinstalling the application.</div><button class="btn btn-primary" type="button" data-settings-export>${Icons.download} Export backup</button></div></div></section>
    </div>
  </div>`,footer:`<button class="btn btn-ghost" data-mclose>Close</button><button class="btn btn-primary" data-ok>Save settings</button>`,onMount(ov){
    const compact=ov.querySelector('[name="compact"]'), motion=ov.querySelector('[name="motion"]'), startPage=ov.querySelector('[name="startPage"]');
    bindResidenceTypeSetting(ov.querySelector('[name="residenceType"]'));
    compact.checked=localStorage.getItem('hebergia_compact')==='1'; motion.checked=localStorage.getItem('hebergia_motion')!=='0'; startPage.value=localStorage.getItem('hebergia_start_page')||'dashboard';
    ov.querySelectorAll('[data-settings-tab]').forEach(tab=>tab.addEventListener('click',()=>{ ov.querySelectorAll('[data-settings-tab]').forEach(x=>x.classList.toggle('active',x===tab)); ov.querySelectorAll('[data-settings-panel]').forEach(panel=>panel.hidden=panel.dataset.settingsPanel!==tab.dataset.settingsTab); }));
    ov.querySelector('[data-settings-export]').addEventListener('click',exportBackup);
    ov.querySelector('[data-ok]').addEventListener('click',()=>{ localStorage.setItem('hebergia_compact',compact.checked?'1':'0'); localStorage.setItem('hebergia_motion',motion.checked?'1':'0'); localStorage.setItem('hebergia_start_page',startPage.value); Modal.close(); toast('Settings saved.','success'); });
  }});
    translateRenderedUi(document.querySelector('#modal-root .overlay.show'));
}
async function exportBackup(){
  const snap=await snapshot();
  const students=await Store.list('students');
  const data={...snap,students:students.map(s=>({...s,nomComplet:s.nomComplet||[s.nom,s.prenom].filter(Boolean).join(' ')}))};
  const blob=new Blob([JSON.stringify({exportedAt:nowISO(),version:4,data},null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob),link=document.createElement('a');
  link.href=url;link.download=`hebergia-backup-${new Date().toISOString().slice(0,10)}.json`;link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  toast('Sauvegarde complète exportée.','success');
}
async function importBackup(event){
  const input=event.target;
  const file=input.files?.[0];
  if(!file) return;
  await safe(async()=>{
    if(file.size>100*1024*1024) throw AppError('Le fichier de sauvegarde dépasse la taille maximale de 100 Mo.');
    let parsed;
    try {
      parsed=JSON.parse(await file.text());
    } catch(error) {
      if(error instanceof SyntaxError) throw AppError('Le fichier sélectionné ne contient pas un JSON valide.');
      throw error;
    }
    const data=validateBackupPayload(parsed);
    assertResidenceTypeCompatible(residenceGenderType(),data.students);
    const counts=backupCollectionCounts(data);
    const message=`La restauration remplacera toutes les données locales par celles du fichier « ${file.name} ».\n\n${counts.students.toLocaleString('fr-FR')} résidents · ${counts.rooms.toLocaleString('fr-FR')} chambres · ${counts.history.toLocaleString('fr-FR')} mouvements · ${counts.complaints.toLocaleString('fr-FR')} réclamations.\n\nLa sauvegarde peut encore contenir des mots de passe en clair pour des comptes qui ne se sont pas connectés depuis l’ajout de la protection ; ils seront convertis après leur prochaine connexion. Les photos stockées dans un dossier séparé ne sont pas incluses.`;
    if(!(await confirmDialog({title:'Restaurer la sauvegarde ?',danger:true,ok:'Restaurer',message}))) return;
    await Store.replaceAll(data);
    toast('Sauvegarde restaurée.','success');
    location.reload();
  });
  input.value='';
}
async function resetAppData(){ if(!(await confirmDialog({title:'Réinitialiser l’application',danger:true,ok:'Tout supprimer',message:'Toutes les données locales seront supprimées et la démonstration initiale sera restaurée. Cette action est irréversible.'}))) return; await Store.wipe(); localStorage.clear(); sessionStorage.clear(); location.reload(); }
async function openProfileForm(){
  closeProfileMenu();
  const user=Session.user;
  Modal.open({ title:'Mon profil', sub:'Modifier vos informations personnelles', body:`<div class="fgrid">
    <div class="field full"><label>Nom complet <span class="req">*</span></label><input class="inp" name="name" required value="${esc(user.name)}"></div>
    <div class="field full"><label>Avatar</label><div class="avatar-upload"><span class="avatar" data-avatar-preview>${user.avatar?.startsWith('data:image/')?`<img src="${user.avatar}" alt="Avatar">`:esc(user.avatar||initials(user.name))}</span><input class="inp" type="file" accept="image/*" data-avatar-file><input type="hidden" name="avatar" value="${esc(user.avatar||'')}"></div><div style="font-size:11px;color:var(--muted);margin-top:4px">Choisissez une image pour votre avatar.</div></div>
    <div class="field"><label>Nouveau mot de passe</label><input class="inp" type="password" name="password" placeholder="Laisser vide = inchangé"></div>
  </div>`, footer:`<button class="btn btn-ghost" data-mclose>Annuler</button><button class="btn btn-primary" data-ok>Enregistrer</button>`, onMount(ov){ bindAvatarUpload(ov); ov.querySelector('[data-ok]').addEventListener('click', async e=>{ e.preventDefault(); await safe(async()=>{ const fd=Object.fromEntries(new FormData(ov.querySelector('form')).entries()); const name=String(fd.name||'').trim(); const avatar=ov.dataset.avatarData||String(fd.avatar||'').trim().toUpperCase().slice(0,3)||initials(name); if(!name) throw AppError('Le nom est obligatoire.'); const patch={name,avatar}; if(fd.password) patch.password=await hashPassword(fd.password); await Store.update('users',user.id,patch); Session.user={...user,...patch}; $('chip-name').textContent=name; setUserAvatar($('chip-avatar'),Session.user); Modal.close(); toast('Profil mis à jour.','success'); }); }); } });
}
/* ══════════════ SECTION 17 — DÉLÉGATION D'ÉVÉNEMENTS & CABLAGE GLOBAL ══════════════ */
const Actions = {
  /* — Étudiants — */
  'new-student':   ()=>{ if (!Session.user) return; openStudentForm(null); },
  'renewal-tracking': ()=>openRenewalTracking(),
  'students-unassigned': ()=>{
    StudentsView.q='';
    StudentsView.statut='actif';
    StudentsView.academicYear=academicYearFor(nowISO());
    StudentsView.annee='';
    StudentsView.sexe='';
    StudentsView.bloc='none';
    StudentsView.page=1;
    return renderStudents();
  },
  'stu-renewal': t=>openStudentRenewalForm(t.dataset.id),
  'renewal-dossier': t=>openRenewalDossier(t.dataset.id),
  'students-page': t => { StudentsView.page=Number(t.dataset.page)||1; return renderStudentsTable(); },
  'stu-open':      t => openStudentFiche(t.dataset.id),
  'stu-edit':      async t => { const s = await Store.get('students', t.dataset.id); openStudentForm(s); },
  'stu-assign':    async t => { const s = await Store.get('students', t.dataset.id); openAssignFromStudent(s); },
  'stu-transfer':  async t => { const s = await Store.get('students', t.dataset.id); openTransfer(s); },
  'stu-release':   async t => { const s = await Store.get('students', t.dataset.id); openRelease(s); },
  'stu-del':       async t => {
    const s = await Store.get('students', t.dataset.id);
    if (!s) return;
    if (!(await confirmDialog({ title:'Supprimer l\u2019étudiant', danger:true, ok:'Supprimer définitivement',
      message:`Supprimer la fiche de <b>${esc(s.prenom)} ${esc(s.nom)}</b> (${esc(s.matricule)}) ?<br>Cette action est irréversible.` }))) return;
    await safe(async ()=>{ await Services.deleteStudent(s.id); toast('Étudiant supprimé.','success'); await refresh(); });
  },
  /* — Chambres — */
  'new-room':  ()=>{ if (!Session.user) return; openRoomForm(null); },
  'new-block': ()=>{ if (!Session.user) return; openBlockForm(); },
  'block-edit': t => editBlock(t.dataset.bloc),
  'block-del': t => deleteBlock(t.dataset.bloc),
  'new-floor': ()=>{ if (!Session.user) return; openFloorForm(); },
  'floor-add-room': t => addRoomToFloor(t.dataset.bloc, t.dataset.floor),
  'floor-edit': t => editFloor(t.dataset.bloc, t.dataset.floor),
  'floor-del': t => deleteFloor(t.dataset.bloc, t.dataset.floor),
  'room-open': t => openRoom(t.dataset.id),
  'rooms-pdf': ()=>exportRoomsPdf(),
  'report-pdf': ()=>window.print(),
  /* — Utilisateurs (admin) — */
  'new-user':    ()=>{ requireAdmin(); openUserForm(null); },
  'user-edit':   async t => { requireAdmin(); const u = await Store.get('users', t.dataset.id); openUserForm(u); },
  'user-toggle': async t => {
    requireAdmin();
    const u = await Store.get('users', t.dataset.id);
    if (u.id === Session.user.id) return toast('Impossible de désactiver votre propre compte.','warning');
    await safe(async ()=>{
      await Store.update('users', u.id, { active: !u.active });
      toast(u.active ? 'Compte désactivé.' : 'Compte réactivé.', 'success'); await refresh();
    });
  },
  'user-del': async t => {
    requireAdmin();
    const u = await Store.get('users', t.dataset.id);
    if (u.id === Session.user.id) return;
    if (!(await confirmDialog({ title:'Supprimer le compte', danger:true, ok:'Supprimer',
      message:`Supprimer définitivement le compte de <b>${esc(u.name)}</b> ?` }))) return;
    await safe(async ()=>{ await Store.remove('users', u.id); toast('Compte supprimé.','success'); await refresh(); });
  },
  /* — Global — */
  'profile-menu-toggle': ()=> toggleProfileMenu(),
  'about-app': ()=> openAboutApp(),
  'settings': ()=>{ closeProfileMenu(); showView('settings'); },
    'open-import-wizard': ()=>{ closeProfileMenu(); startImportWizard(); },
  'toggle-sidebar': ()=>{
    const app=$('app');
    if(window.innerWidth<=767){
      const opening=app.classList.contains('sidebar-collapsed');
      setSidebarCollapsed(!opening); app.classList.toggle('sidebar-flyout-open',opening);
    } else setSidebarCollapsed(!app.classList.contains('sidebar-collapsed'));
  },
  'toggle-theme': ()=> toggleTheme(),
  'profile-edit': ()=> openProfileForm(),
  'logout': ()=> logout(),
  'view-export': t => {
    const kind=t.dataset.exportKind, format=localStorage.getItem('hebergia_export_format')||'excel';
    if(format==='excel') return exportDataExcel(kind);
    if(format==='csv') {
      if(kind==='rooms') return exportRooms();
      if(kind==='history') return exportHistory();
      if(kind==='reports') return exportReports();
      return kind==='students'?exportStudents():exportRecs();
    }
    if(kind==='rooms') return exportViewJSON('rooms');
    if(kind==='history') return exportViewJSON('history');
    if(kind==='reports') return exportViewJSON('reports');
    return exportViewJSON(kind);
  },
  'settings-export': () => {
    const format=selectedExportFormat();
    if(format==='excel') return exportDataExcel();
    if(format==='csv') return exportDataCSV();
    return exportDataJSON();
  },
  'select-export-format': t => {
    const format=t.dataset.exportFormat;
    if(!['excel','csv','json'].includes(format)) return;
    localStorage.setItem('hebergia_export_format',format);
    document.querySelectorAll('.view-export').forEach(control=>{
      control.dataset.format=format;
      const label=control.querySelector('[data-export-format-label]');
      if(label) label.textContent=`Exporter (${format==='excel'?'Excel':format.toUpperCase()})`;
      control.querySelectorAll('[data-action="select-export-format"]').forEach(option=>option.setAttribute('aria-pressed',String(option.dataset.exportFormat===format)));
      control.querySelector('details[open]')?.removeAttribute('open');
    });
  },
  'export-students': () => exportStudents(),
  'export-recs':     () => exportRecs(),
  'reset-demo': async ()=>{
    requireAdmin();
    if (!(await confirmDialog({ title:'Réinitialiser la démonstration', danger:true, ok:'Réinitialiser',
      message:'Toutes les données saisies seront effacées et le jeu de démonstration sera restauré.' }))) return;
    Store.wipe(); sessionStorage.removeItem('hg_session'); location.reload();
  }
};

function enhanceThemePicker(){
  const select=document.querySelector('#settings-page-root select[name="theme"]');
  if(!select||select.dataset.themePicker) return;
  select.dataset.themePicker='1';
  select.classList.add('theme-value');
  const palettes={hebergia:['#146b72','#f39a2f','#083d47'],blue:['#2169a5','#eea33b','#123b63'],green:['#16805f','#e9a33b','#0a4437'],orange:['#d66d2d','#f2a51f','#61321f'],plum:['#79508c','#d5a153','#42294f'],slate:['#3f6170','#b7a365','#263e49']};
  const wrap=document.createElement('div');
  wrap.className='theme-options'; wrap.setAttribute('role','radiogroup'); wrap.setAttribute('aria-label','Choisir un thème de couleur');
  [...select.options].forEach(option=>{
    const button=document.createElement('button'); button.type='button'; button.className='theme-choice'; button.dataset.themeChoice=option.value; button.setAttribute('role','radio');
    const colors=palettes[option.value]||palettes.hebergia;
    button.innerHTML=`<span class="theme-preview">${colors.map(color=>`<i style="background:${color}"></i>`).join('')}</span><span>${option.textContent}</span>`;
    button.addEventListener('click',()=>{ select.value=option.value; wrap.querySelectorAll('.theme-choice').forEach(choice=>{ const active=choice===button; choice.classList.toggle('active',active); choice.setAttribute('aria-checked',String(active)); }); persistSettings(select.closest('#settings-page-root')); });
    wrap.appendChild(button);
  });
  select.parentElement.appendChild(wrap);
  const current=wrap.querySelector(`[data-theme-choice="${CSS.escape(select.value)}"]`); if(current) current.click();
}
function enhanceModePicker(){
  const select=document.querySelector('#settings-page-root select[name="mode"]');
  if(!select||select.dataset.modePicker) return;
  select.dataset.modePicker='1'; select.classList.add('theme-value');
  const wrap=document.createElement('div'); wrap.className='mode-options'; wrap.setAttribute('role','radiogroup'); wrap.setAttribute('aria-label','Choisir le mode d’affichage');
  [...select.options].forEach(option=>{
    const label=document.createElement('label'); label.className='mode-choice';
    const input=document.createElement('input'); input.type='radio'; input.name='mode-radio'; input.value=option.value; input.checked=option.value===select.value;
    const text=document.createElement('span'); text.textContent=option.textContent;
    input.addEventListener('change',()=>{ if(input.checked){ select.value=input.value; select.dispatchEvent(new Event('change',{bubbles:true})); } });
    label.append(input,text); wrap.appendChild(label);
  });
  select.parentElement.appendChild(wrap);
}
function enhanceTextSizePicker(){
  const select=document.querySelector('#settings-page-root select[name="textSize"]');
  if(!select||select.dataset.textSizePicker) return;
  select.dataset.textSizePicker='1'; select.classList.add('theme-value');
  const wrap=document.createElement('div'); wrap.className='mode-options'; wrap.setAttribute('role','radiogroup'); wrap.setAttribute('aria-label','Choisir la taille du texte');
  [...select.options].forEach(option=>{
    const label=document.createElement('label'); label.className='mode-choice';
    const input=document.createElement('input'); input.type='radio'; input.name='text-size-radio'; input.value=option.value; input.checked=option.value===select.value;
    const text=document.createElement('span'); text.textContent=option.textContent;
    input.addEventListener('change',()=>{ if(input.checked){ select.value=input.value; select.dispatchEvent(new Event('change',{bubbles:true})); } });
    label.append(input,text); wrap.appendChild(label);
  });
  select.parentElement.appendChild(wrap);
}
function groupFontPickers(){
  const panel=document.querySelector('#settings-page-root [data-settings-page-panel="appearance"]');
  const title=panel?.querySelector('[name="titleFont"]')?.closest('.field');
  const body=panel?.querySelector('[name="bodyFont"]')?.closest('.field');
  if(!panel||!title||!body||title.parentElement.classList.contains('font-fields')) return;
  const group=document.createElement('div'); group.className='font-settings-group';
  const heading=document.createElement('h5'); heading.textContent='POLICES';
  const fields=document.createElement('div'); fields.className='font-fields';
  group.append(heading,fields); panel.insertBefore(group,title); fields.append(title,body);
}
function enhanceSettingsPickers(){ enhanceThemePicker(); enhanceModePicker(); enhanceTextSizePicker(); groupFontPickers(); }
function persistSettings(root){
  if(!root) return;
  const value=name=>root.querySelector(`[name="${name}"]`)?.value;
  const universityDirection=value('universityDirection');
  if(universityDirection!==undefined) localStorage.setItem('hebergia_university_direction',universityDirection.trim());
  const establishment=value('establishment');
  if(establishment!==undefined) localStorage.setItem('hebergia_establishment',establishment.trim()||'Résidence universitaire Pepiniere');
  ['mode','theme','titleFont','bodyFont','textSize','startPage'].forEach(name=>{ const current=value(name); if(current!==undefined) localStorage.setItem({mode:'hebergia_mode',theme:'hebergia_theme',titleFont:'hebergia_title_font',bodyFont:'hebergia_body_font',textSize:'hebergia_text_size',startPage:'hebergia_start_page'}[name],current); });
  const compact=root.querySelector('[name="compact"]'), motion=root.querySelector('[name="motion"]');
  if(compact) localStorage.setItem('hebergia_compact',compact.checked?'1':'0');
  if(motion) localStorage.setItem('hebergia_motion',motion.checked?'1':'0');
  applyPreferences();
  document.querySelectorAll('.brand-sub').forEach(el=>el.textContent=localStorage.getItem('hebergia_establishment')||el.textContent);
}
function setSidebarWidth(width,persist=true){
  const min=190, max=Math.max(min,Math.min(380,window.innerWidth-420));
  const value=Math.round(Math.min(max,Math.max(min,width)));
  $('app').style.setProperty('--sidebar-width',`${value}px`);
  $('sidebar-resizer').setAttribute('aria-valuenow',String(value));
  if(persist) localStorage.setItem('hebergia_sidebar_width',String(value));
}
function setSidebarCollapsed(collapsed,persist=true){
  $('app').classList.toggle('sidebar-collapsed',collapsed);
  const label=collapsed?'Ouvrir la barre latérale':'Réduire la barre latérale';
  const button=$('sidebar-edge-toggle');
  button.innerHTML=collapsed?Icons.sidebarExpand:Icons.sidebarCollapse;
  button.title=`${label} (Ctrl/Cmd + B)`; button.dataset.tooltip=`${label} · Ctrl/Cmd + B`;
  button.setAttribute('aria-label',label); button.setAttribute('aria-expanded',String(!collapsed));
  if(persist) localStorage.setItem('hebergia_sidebar_collapsed',collapsed?'1':'0');
}
function initializeSidebarControls(){
  const savedWidth=Number(localStorage.getItem('hebergia_sidebar_width'));
  setSidebarWidth(Number.isFinite(savedWidth)&&savedWidth>0?savedWidth:288,false);
  setSidebarCollapsed(window.innerWidth<=767||localStorage.getItem('hebergia_sidebar_collapsed')==='1',false);
  const resizer=$('sidebar-resizer');
  let resizing=false;
  resizer.addEventListener('pointerdown',event=>{
    if(event.button!==0||window.innerWidth<=767) return;
    event.preventDefault();
    if($('app').classList.contains('sidebar-collapsed')) setSidebarCollapsed(false);
    resizing=true; resizer.setPointerCapture(event.pointerId); document.body.classList.add('sidebar-resizing');
  });
  resizer.addEventListener('pointermove',event=>{ if(resizing) setSidebarWidth(event.clientX); });
  const stopResize=()=>{ resizing=false; document.body.classList.remove('sidebar-resizing'); };
  resizer.addEventListener('pointerup',stopResize);
  resizer.addEventListener('pointercancel',stopResize);
  resizer.addEventListener('keydown',event=>{
    const current=parseInt($('app').style.getPropertyValue('--sidebar-width'),10)||288;
    if(event.key==='ArrowLeft'){ event.preventDefault(); setSidebarWidth(current-16); }
    else if(event.key==='ArrowRight'){ event.preventDefault(); setSidebarWidth(current+16); }
    else if(event.key==='Home'){ event.preventDefault(); setSidebarWidth(288); }
  });
}
function wireGlobal(){
  const settingsObserver=new MutationObserver(enhanceSettingsPickers); settingsObserver.observe(document.body,{childList:true,subtree:true});
  enhanceSettingsPickers();
  document.addEventListener('change',e=>{ if(e.target.closest('#settings-page-root')&&['universityDirection','establishment','mode','theme','titleFont','bodyFont','textSize','startPage','compact','motion'].includes(e.target.name)) persistSettings(e.target.closest('#settings-page-root')); });
  /* Icônes de la sidebar (SVG injectés) */
  $('nav-dashboard').innerHTML = Icons.dash + '<span class="nav-label">Tableau de bord</span>';
  $('nav-students').innerHTML  = Icons.users + '<span class="nav-label">Résidents</span>';
  $('nav-renewals').innerHTML  = Icons.clock + '<span class="nav-label">Renouvellements</span>';
  $('nav-rooms').innerHTML     = Icons.bed + '<span class="nav-label">Blocs / Chambres</span>';
  $('nav-history').innerHTML   = Icons.clock + '<span class="nav-label">Historique</span>';
  $('nav-reports').innerHTML   = Icons.dash + '<span class="nav-label">Rapports</span>';
  $('nav-dashboard').title='Tableau de bord'; $('nav-students').title='Résidents'; $('nav-renewals').title='Renouvellements'; $('nav-rooms').title='Blocs / Chambres';
  $('students-export-control').innerHTML=exportControlMarkup('students','view-export');
  $('rooms-export-control').innerHTML=exportControlMarkup('rooms','view-export');
  $('history-export-control').innerHTML=exportControlMarkup('history','view-export');
  $('tb-settings').innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">settings</span>';
  $('tb-about').innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">info</span>';
  initializeSidebarControls();
  updateThemeToggle();

  /* Navigation sidebar + liens « tout voir » */
  document.addEventListener('click', e=>{
    const nav = e.target.closest('[data-nav],[data-nav-go]');
    const app=$('app');
    if(app.classList.contains('sidebar-collapsed')){
      if(nav&&nav.closest('#sidebar')) app.classList.add('sidebar-flyout-open');
      else if(!e.target.closest('#sidebar')) app.classList.remove('sidebar-flyout-open');
    }
    if (nav){
      showView(nav.dataset.nav || nav.dataset.navGo);
      if(window.innerWidth<=767){ setSidebarCollapsed(true); app.classList.remove('sidebar-flyout-open'); }
    }
  });
  let flyoutOpenTimer,flyoutCloseTimer;
  const app=$('app'),sidebar=$('sidebar');
  const openFlyout=()=>{
    clearTimeout(flyoutCloseTimer);
    if(window.innerWidth<=767||!app.classList.contains('sidebar-collapsed')||app.classList.contains('sidebar-flyout-open')) return;
    clearTimeout(flyoutOpenTimer); flyoutOpenTimer=setTimeout(()=>app.classList.add('sidebar-flyout-open'),150);
  };
  const closeFlyout=()=>{
    clearTimeout(flyoutOpenTimer);
    if(!app.classList.contains('sidebar-collapsed')||!app.classList.contains('sidebar-flyout-open')) return;
    clearTimeout(flyoutCloseTimer); flyoutCloseTimer=setTimeout(()=>app.classList.remove('sidebar-flyout-open'),200);
  };
  sidebar.addEventListener('mouseenter',openFlyout);
  sidebar.addEventListener('mouseleave',closeFlyout);
  document.addEventListener('pointermove',event=>{
    if(window.innerWidth<=767||!app.classList.contains('sidebar-collapsed')) return;
    const bounds=sidebar.getBoundingClientRect();
    if(event.clientX<=12||(event.clientX>=bounds.left&&event.clientX<=bounds.right&&event.clientY>=bounds.top&&event.clientY<=bounds.bottom)) openFlyout();
    else closeFlyout();
  });
  $('sidebar-backdrop').addEventListener('click',()=>{ setSidebarCollapsed(true); app.classList.remove('sidebar-flyout-open'); });
  let touchStartX=0;
  sidebar.addEventListener('touchstart',event=>{ touchStartX=event.changedTouches[0]?.clientX||0; },{passive:true});
  sidebar.addEventListener('touchend',event=>{
    const endX=event.changedTouches[0]?.clientX||touchStartX;
    if(window.innerWidth<=767&&touchStartX-endX>60){ setSidebarCollapsed(true); app.classList.remove('sidebar-flyout-open'); }
  },{passive:true});
  document.addEventListener('keydown',event=>{
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='b'){
      event.preventDefault();
      $('sidebar-edge-toggle').click();
    } else if(event.key==='Escape'&&app.classList.contains('sidebar-flyout-open')){
      if(window.innerWidth<=767) setSidebarCollapsed(true);
      app.classList.remove('sidebar-flyout-open');
    }
  });

  /* Délégation générale des actions */
  document.addEventListener('click', e=>{
    const t = e.target.closest('[data-action]');
    if (!t || !Actions[t.dataset.action]) return;
    e.preventDefault();
    safe(()=>Actions[t.dataset.action](t));
  });

  /* Filtres : tout contrôle porteur de data-f met à jour l'état puis re-rend */
  const content=$('content');
  let studentSearchTimer;
  let draggedReportCard=null;
  let reportDragPointerId=null;
  let reportDragStartX=0;
  let reportDragStartY=0;
  let reportDragStarted=false;
  let resizingReportCard=null;
  let resizeStartX=0;
  let resizeStartSpan=0;
  let resizeColumnWidth=0;
  content.addEventListener('pointerdown',e=>{
    if(!ReportsView.layoutEditing) return;
    const title=e.target.closest('.report-card .card-h h3');
    if(!title||e.button!==0) return;
    draggedReportCard=title.closest('.report-card');
    if(!draggedReportCard) return;
    reportDragPointerId=e.pointerId;
    reportDragStartX=e.clientX;
    reportDragStartY=e.clientY;
    reportDragStarted=false;
    e.preventDefault();
    title.setPointerCapture(e.pointerId);
  });
  content.addEventListener('pointermove',e=>{
    if(!ReportsView.layoutEditing||!draggedReportCard||e.pointerId!==reportDragPointerId) return;
    const distance=Math.hypot(e.clientX-reportDragStartX,e.clientY-reportDragStartY);
    if(!reportDragStarted&&distance<6) return;
    if(!reportDragStarted){
      reportDragStarted=true;
      draggedReportCard.querySelector('.card-h h3')?.classList.add('is-dragging');
      draggedReportCard.classList.add('is-dragging');
    }
    const target=reportCardAtPoint($('reports-root'),e.clientX,e.clientY);
    content.querySelectorAll('.report-card.is-drop-before,.report-card.is-drop-after')
      .forEach(card=>card.classList.remove('is-drop-before','is-drop-after'));
    if(!target||target===draggedReportCard) return;
    const bounds=target.getBoundingClientRect();
    const xRatio=(e.clientX-bounds.left)/bounds.width-.5;
    const yRatio=(e.clientY-bounds.top)/bounds.height-.5;
    const after=Math.abs(xRatio)>Math.abs(yRatio)?xRatio>0:yRatio>0;
    target.classList.add(after?'is-drop-after':'is-drop-before');
  });
  const finishReportDrag=(e,cancelled=false)=>{
    if(!draggedReportCard||e.pointerId!==reportDragPointerId) return;
    const source=draggedReportCard;
    const target=reportDragStarted&&!cancelled
      ? reportCardAtPoint($('reports-root'),e.clientX,e.clientY)
      : null;
    if(target&&target!==source){
      const bounds=target.getBoundingClientRect();
      const xRatio=(e.clientX-bounds.left)/bounds.width-.5;
      const yRatio=(e.clientY-bounds.top)/bounds.height-.5;
      const after=Math.abs(xRatio)>Math.abs(yRatio)?xRatio>0:yRatio>0;
      safe(async()=>{moveReportCard($('reports-root'),source,target,after);});
    }
    content.querySelectorAll('.report-card.is-dragging,.report-card.is-drop-before,.report-card.is-drop-after')
      .forEach(card=>card.classList.remove('is-dragging','is-drop-before','is-drop-after'));
    source.querySelector('.card-h h3')?.classList.remove('is-dragging');
    draggedReportCard=null;
    reportDragPointerId=null;
    reportDragStarted=false;
  };
  content.addEventListener('pointerup',finishReportDrag);
  content.addEventListener('pointercancel',e=>finishReportDrag(e,true));
  content.addEventListener('pointerdown',e=>{
    const handle=e.target.closest('[data-report-resize]');
    if(!ReportsView.layoutEditing||!handle) return;
    const card=handle.closest('.report-card'),grid=handle.closest('.report-grid');
    if(!card||!grid) return;
    e.preventDefault();
    resizingReportCard=card;
    resizeStartX=e.clientX;
    resizeStartSpan=Number(card.style.getPropertyValue('--report-card-span'))||6;
    const gap=parseFloat(getComputedStyle(grid).columnGap)||0;
    resizeColumnWidth=(grid.clientWidth-gap*11)/12;
    handle.setPointerCapture(e.pointerId);
  });
  content.addEventListener('pointermove',e=>{
    if(!resizingReportCard||!resizeColumnWidth) return;
    const span=Math.max(4,Math.min(12,resizeStartSpan+Math.round((e.clientX-resizeStartX)/resizeColumnWidth)));
    resizingReportCard.style.setProperty('--report-card-span',span);
    resizingReportCard.querySelector('[data-report-resize]')?.setAttribute('aria-valuenow',String(span));
  });
  const finishReportResize=()=>{
    if(!resizingReportCard) return;
    resizingReportCard=null;
    resizeColumnWidth=0;
    safe(async()=>saveReportCardLayout($('reports-root')));
  };
  content.addEventListener('pointerup',finishReportResize);
  content.addEventListener('pointercancel',finishReportResize);
  content.addEventListener('keydown',e=>{
    const resizeHandle=e.target.closest('[data-report-resize]');
    if(ReportsView.layoutEditing&&resizeHandle&&['ArrowLeft','ArrowRight'].includes(e.key)){
      e.preventDefault();
      const card=resizeHandle.closest('.report-card');
      const span=Math.max(4,Math.min(12,(Number(card.style.getPropertyValue('--report-card-span'))||6)+(e.key==='ArrowRight'?1:-1)));
      card.style.setProperty('--report-card-span',span);
      resizeHandle.setAttribute('aria-valuenow',String(span));
      safe(async()=>saveReportCardLayout($('reports-root')));
      return;
    }
    if(!ReportsView.layoutEditing) return;
    const title=e.target.closest('.report-card .card-h h3');
    if(!title||!['ArrowUp','ArrowDown'].includes(e.key)) return;
    const card=title.closest('.report-card');
    const cards=[...$('reports-root').querySelectorAll('.report-grid > .report-card')];
    const index=cards.indexOf(card);
    const target=e.key==='ArrowUp'?cards[index-1]:cards[index+1];
    if(!target) return;
    e.preventDefault();
    safe(async()=>{moveReportCard($('reports-root'),card,target,e.key==='ArrowDown');title.focus();});
  });
  content.addEventListener('click',e=>{
    const layoutControl=e.target.closest('[data-report-layout-toggle],[data-report-layout-done],[data-report-layout-reset],[data-report-hide-card],[data-report-show-card]');
    if(layoutControl){
      safe(async()=>{
        if(layoutControl.matches('[data-report-layout-toggle]')){
          ReportsView.layoutEditing=true;
          await renderReports();
          $('reports-root').querySelector('.report-card .card-h h3')?.focus();
        } else if(layoutControl.matches('[data-report-layout-done]')){
          ReportsView.layoutEditing=false;
          await renderReports();
          $('reports-root').querySelector('[data-report-layout-toggle]')?.focus();
        } else if(layoutControl.matches('[data-report-layout-reset]')){
          localStorage.removeItem(REPORT_CARD_ORDER_KEY);
          localStorage.removeItem(REPORT_CARD_HIDDEN_KEY);
          localStorage.removeItem(REPORT_CARD_SPANS_KEY);
          ReportsView.layoutEditing=true;
          await renderReports();
          $('reports-root').querySelector('.report-card .card-h h3')?.focus();
        } else {
          const id=layoutControl.dataset.reportHideCard||layoutControl.dataset.reportShowCard;
          const card=$('reports-root').querySelector(`[data-report-card="${CSS.escape(id)}"]`);
          if(!card) return;
          card.hidden=layoutControl.hasAttribute('data-report-hide-card');
          saveReportCardLayout($('reports-root'));
          await renderReports();
          const focusTarget=card.hidden
            ? $('reports-root').querySelector(`[data-report-show-card="${CSS.escape(id)}"]`)
            : $('reports-root').querySelector(`[data-report-hide-card="${CSS.escape(id)}"]`);
          (focusTarget||$('reports-root').querySelector('[data-report-layout-done]'))?.focus();
        }
      });
      return;
    }
    const blockButton=e.target.closest('[data-report-block]');
    const clearButton=e.target.closest('[data-report-clear-block]');
    if(!blockButton&&!clearButton) return;
    const focusBlock=blockButton?.dataset.reportBlock||ReportsView.selectedBlock;
    ReportsView.selectedBlock=blockButton
      ? ReportsView.selectedBlock===blockButton.dataset.reportBlock?null:blockButton.dataset.reportBlock
      : null;
    safe(async()=>{
      await renderReports();
      const reportRoot=$('reports-root');
      const detailCard=reportRoot.querySelector('[data-report-card="block-detail"]');
      const detailHeading=reportRoot.querySelector('#report-block-detail-title');
      detailCard?.scrollIntoView({behavior:'smooth',block:'start'});
      detailHeading?.focus({preventScroll:true});
      const visibleRows=detailCard?.querySelectorAll('.report-table tbody tr').length||0;
      reportRoot.querySelector('[data-report-drag-status]').textContent=ReportsView.selectedBlock
        ? `Tableau filtré sur ${ReportsView.selectedBlock} : ${visibleRows} bloc affiché.`
        : 'Filtre supprimé : tous les blocs sont affichés.';
    });
  });
  content.addEventListener('input',e=>{
    if(e.target.matches('#stu-q')){
      clearTimeout(studentSearchTimer);
      studentSearchTimer=setTimeout(()=>safe(()=>onFilterChange(e)),180);
      return;
    }
    safe(()=>onFilterChange(e));
  });
  content.addEventListener('change',e=>{
    if(e.target.matches('[data-report-movement-months]')){
      const months=Number(e.target.value);
      if([3,6,12].includes(months)){
        ReportsView.movementMonths=months;
        safe(renderReports);
      }
      return;
    }
    if(e.target.matches('[data-students-page-size]')){
      StudentsView.pageSize=Number(e.target.value)||50;
      StudentsView.page=1;
      safe(renderStudentsTable);
      return;
    }
    safe(()=>onFilterChange(e));
  });

  /* Formulaire de connexion */
  $('login-form').addEventListener('submit', async e=>{
    e.preventDefault();
    const username = $('lg-user').value.trim().toLowerCase();
    const password = $('lg-pass').value;
    if ($('lg-remember').checked) localStorage.setItem('hebergia_login_username', username);
    else localStorage.removeItem('hebergia_login_username');
    await safe(async()=>{
      const users = await Store.list('users');
      const u = users.find(x => (x.username.toLowerCase() === username || String(x.phone||'').toLowerCase() === username));
      const result = u ? await verifyPassword(password, u.password) : { valid:false, needsRehash:false };
      const err = $('login-err');
      if (!u || !result.valid){ err.hidden=false; err.textContent='Identifiants incorrects.'; return; }
      if (!u.active){ err.hidden=false; err.textContent='Ce compte est désactivé. Contactez l\u2019administrateur.'; return; }
      if (result.needsRehash) {
        u.password = await hashPassword(password);
        await Store.update('users', u.id, { password:u.password });
      }
      err.hidden=true;
      enterApp(u);
    });
  });
  const savedLoginUsername = localStorage.getItem('hebergia_login_username');
  if (savedLoginUsername){ $('lg-user').value = savedLoginUsername; $('lg-remember').checked = true; }
  $('forgot-password').addEventListener('click', e=>{
    e.preventDefault();
    const err = $('login-err');
    err.hidden = false;
    err.textContent = 'Contactez l’administrateur pour réinitialiser votre mot de passe.';
    err.className = 'login-err login-help';
  });

  /* Fermeture des modales avec Échap */
  document.addEventListener('keydown', e=>{
    if(e.key!=='Escape') return;
    if($('app').classList.contains('sidebar-collapsed')) $('app').classList.remove('sidebar-flyout-open');
    Modal.close();
  });

  /* Redimensionnement : on redessine les graphiques du tableau de bord */
  let rsz;
  window.addEventListener('resize', ()=>{
    clearTimeout(rsz);
    rsz = setTimeout(()=>{ if (Session.user && currentView==='dashboard') renderDashboard(); }, 220);
  });
}

/* Réagit à tout changement de filtre (data-f="module.champ") */
async function onFilterChange(e){
  const el = e.target;
  const f = el.dataset.f;
  if (!f) return;
  const [mod, key] = f.split('.');
  const val = el.value;
  if (mod==='students'){ StudentsView[key] = val; StudentsView.page=1; await renderStudentsTable(); }
  if (mod==='rooms'){ RoomsView[key] = val; await safe(renderRooms); }
  if (mod==='rec'){ RecView[key] = val; await safe(renderComplaintsTable); }
  if (mod==='hist'){
    HistView[key] = key==='from' || key==='to' ? (parseDisplayDate(val) ?? '') : val;
    await safe(renderHistoryList);
  }
}

/* ══════════════ SECTION 18 — DÉCOR DE CONNEXION & DÉMARRAGE ══════════════ */
function buildSkyline(){
  const wrap = $('skyline');
  if (!wrap) return;
  wrap.innerHTML = '';
  [[7,5],[10,7],[5,4]].forEach(([rows,cols])=>{
    const b = document.createElement('div');
    b.className = 'bld';
    b.style.setProperty('--cols', cols);
    for (let i=0; i<rows*cols; i++){
      const w = document.createElement('span');
      w.className = 'win' + (Math.random()<0.34 ? ' lit' : '');
      if (w.classList.contains('lit')) w.style.animationDelay = (Math.random()*4).toFixed(2)+'s';
      b.appendChild(w);
    }
    wrap.appendChild(b);
  });
}
async function fillLoginStats(){
  const snap = await snapshot();
  const beds = snap.rooms.filter(r=>r.statut!=='hors_service').reduce((a,r)=>a+r.capacite,0);
  const housed = snap.students.filter(s=>s.chambreId && s.statut==='actif').length;
  $('login-stats').innerHTML =
    `<div><b>${[...new Set(snap.rooms.map(r=>r.bloc))].length}</b>blocs</div>
     <div><b>${snap.rooms.length}</b>chambres</div>
     <div><b>${beds}</b>lits</div>
     <div><b>${housed}</b>étudiants hébergés</div>`;
}

async function openFirstAdminSetup(){
  Modal.open({title:'Premier démarrage',sub:'Créez le compte administrateur principal',body:`<div class="fgrid"><div class="field full"><label>Nom complet <span class="req">*</span></label><input class="inp" name="name" required placeholder="Votre nom"></div><div class="field"><label>Nom d’utilisateur <span class="req">*</span></label><input class="inp" name="username" required></div><div class="field"><label>Téléphone</label><input class="inp" name="phone" placeholder="05…"></div><div class="field"><label>Mot de passe <span class="req">*</span></label><input class="inp" type="password" name="password" required></div><div class="field"><label>Avatar</label><input class="inp" name="avatar" placeholder="Initiales"></div></div><p class="report-note">Ce premier compte sera Administrateur et disposera de tous les privilèges.</p>`,footer:`<button class="btn btn-primary" data-ok>Créer l’administrateur</button>`,onMount(ov){ov.querySelector('[data-ok]').addEventListener('click',async e=>{e.preventDefault();await safe(async()=>{const fd=Object.fromEntries(new FormData(ov.querySelector('form')).entries());const name=String(fd.name||'').trim(),username=String(fd.username||'').trim().toLowerCase(),password=String(fd.password||'');if(!name||!username||!password)throw AppError('Nom, identifiant et mot de passe obligatoires.');const user={id:uid(),name,username,phone:String(fd.phone||'').trim(),avatar:String(fd.avatar||initials(name)).trim().toUpperCase(),password:await hashPassword(password),role:'admin',bloc:null,active:true};await Store.insert('users',user);Modal.close();enterApp(user);toast('Compte administrateur créé.','success');});});}});
}

(async function boot(){
  /* Nettoyage de publication : vider une seule fois les anciennes données de démonstration
     et remettre les préférences locales à zéro avant la version vierge. */
  const cleanKey='hebergia_clean_install_1_0_0';
  if(localStorage.getItem(cleanKey)!=='done'){
    await Store.wipe();
    Object.keys(localStorage).filter(key=>key.startsWith('hebergia_')||key==='hg_session').forEach(key=>localStorage.removeItem(key));
    sessionStorage.clear();
    localStorage.setItem(cleanKey,'done');
  }
  /* Initialisation de la base locale : aucune donnée de démonstration. */
  await Store.init(buildSeed);
  buildSkyline();
  await fillLoginStats();
  wireGlobal();
  const accounts=await Store.list('users'); const legacy=['admin','sbensalah','mbrahimi','nzerrouki']; if(accounts.length&&accounts.every(u=>legacy.includes(String(u.username||'').toLowerCase()))){ for(const u of accounts) await Store.remove('users',u.id); }
  if (!(await Store.list('users')).length){ openFirstAdminSetup(); return; }
  /* Session persistante (onglet courant) : reprise automatique. */
  const sid = sessionStorage.getItem('hg_session');
  if (sid){
    const u = await Store.get('users', sid);
    if (u && u.active){ enterApp(u); return; }
    sessionStorage.removeItem('hg_session');
  }
})();
