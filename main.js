const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, Notification, shell } = require('electron');
const path = require('path');
const Store = require('electron-store');
const AutoLaunch = require('auto-launch');
const PrinterService = require('./printer-service');

// Carrega variáveis de ambiente
require('dotenv').config({ path: path.join(__dirname, '.env') });

// Credenciais do Supabase (com fallback seguro do projeto)
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://askqkwvpjhotytmxcfqx.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFza3Frd3ZwamhvdHl0bXhjZnF4Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjY0NzE1MywiZXhwIjoyMDg4MjIzMTUzfQ.j3AHuquIhkE_n1-JqzVhUga_j1aEPbrCN0AogqdFO7o';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFza3Frd3ZwamhvdHl0bXhjZnF4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI2NDcxNTMsImV4cCI6MjA4ODIyMzE1M30.GDFVXEYt0aZSMgZ6xhyrl9oA-DeKqP1i4JkyukWQ06A';

// ============================================
// CONFIGURAÇÃO GLOBAL
// ============================================
const store = new Store({
  defaults: {
    empresaId: '',
    nomeLoja: '',
    logoPath: '',
    fontSize: 'media',       // pequena, media, grande
    paperWidth: '80',         // 58 ou 80
    extraLines: 3,            // linhas extras para corte
    copies: 1,                // quantidade de copias
    printerName: '',          // nome da impressora (vazio = padrão)
    autoStart: true,
    configured: false
  }
});

// Limpa credenciais obsoletas salvas localmente para segurança
if (store.has('supabaseUrl')) store.delete('supabaseUrl');
if (store.has('supabaseKey')) store.delete('supabaseKey');
if (store.has('supabaseAnonKey')) store.delete('supabaseAnonKey');

let mainWindow = null;
let tray = null;
let printerService = null;
let isQuitting = false;

// Auto-launch config
const autoLauncher = new AutoLaunch({
  name: 'ProIA Delivery Print',
  path: app.getPath('exe')
});

// ============================================
// TRAY ICONS (gerados programaticamente)
// ============================================
function createTrayIcon() {
  // Gera um ícone 16x16 como PNG via data URL
  const size = 16;
  const svgXml = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${size}" height="${size}" rx="3" fill="#4f46e5"/>
    <text x="${size / 2}" y="${size / 2 + 4}" text-anchor="middle" fill="white" font-size="10" font-family="Arial" font-weight="bold">P</text>
  </svg>`;

  const base64 = Buffer.from(svgXml).toString('base64');
  const dataUrl = `data:image/svg+xml;base64,${base64}`;

  try {
    return nativeImage.createFromDataURL(dataUrl).resize({ width: 16, height: 16 });
  } catch (e) {
    return nativeImage.createEmpty();
  }
}

// ============================================
// JANELA PRINCIPAL
// ============================================
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 520,
    height: 720,
    resizable: false,
    frame: false,
    transparent: false,
    backgroundColor: '#0f0f1a',
    icon: path.join(__dirname, 'assets', 'icon512x512-dark.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    },
    show: false
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Em vez de fechar, esconde na bandeja
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

// ============================================
// SYSTEM TRAY
// ============================================
function createTray() {
  // Usa o mesmo ícone do app para a bandeja do sistema
  const iconPath = path.join(__dirname, 'assets', 'icon512x512-dark.png');
  let trayIcon;

  try {
    const fs = require('fs');
    if (fs.existsSync(iconPath)) {
      trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 22, height: 22 });
    } else {
      trayIcon = createTrayIcon();
    }
  } catch (e) {
    trayIcon = createTrayIcon();
  }

  tray = new Tray(trayIcon);

  updateTrayMenu('desconectado');
  tray.setToolTip('ProIA Delivery Print - Aguardando conexão...');

  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.focus();
      } else {
        mainWindow.show();
      }
    }
  });
}

let updateAvailableInfo = null;

function compareVersions(v1, v2) {
  const p1 = (v1 || '0').split('.').map(Number);
  const p2 = (v2 || '0').split('.').map(Number);
  for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
    const n1 = p1[i] || 0;
    const n2 = p2[i] || 0;
    if (n1 > n2) return 1;
    if (n1 < n2) return -1;
  }
  return 0;
}

async function checkForUpdates() {
  try {
    const currentVersion = app.getVersion() || '2.0.2';
    const res = await fetch(`${SUPABASE_URL}/rest/v1/app_versoes?select=*&order=created_at.desc&limit=1`, {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
      }
    });
    if (!res.ok) return { updateAvailable: false };
    const data = await res.json();
    if (!data || !data.length) return { updateAvailable: false };

    const latest = data[0];
    const isNewer = compareVersions(latest.versao, currentVersion) > 0;
    if (isNewer) {
      updateAvailableInfo = latest;
      showNotification('🚀 Atualização Disponível!', `Nova versão v${latest.versao} do ProIA Delivery Print disponível.`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-available', latest);
      }
      if (tray) {
        updateTrayMenu(printerService ? (printerService._currentStatus || 'conectado') : 'desconectado');
      }
      return { updateAvailable: true, latest };
    }
    return { updateAvailable: false, currentVersion };
  } catch (err) {
    console.error('Erro ao verificar atualizações:', err.message);
    return { updateAvailable: false, error: err.message };
  }
}

function updateTrayMenu(status) {
  const statusLabels = {
    'conectado': '🟢 Conectado - Aguardando pedidos',
    'reconectando': '🟡 Reconectando...',
    'desconectado': '🔴 Desconectado',
    'erro': '🔴 Erro na conexão'
  };

  const menuItems = [
    { label: statusLabels[status] || statusLabels.desconectado, enabled: false },
    { type: 'separator' }
  ];

  if (updateAvailableInfo) {
    menuItems.push({
      label: `🚀 Nova Versão v${updateAvailableInfo.versao} Disponível!`,
      click: () => {
        if (mainWindow) mainWindow.show();
        const url = updateAvailableInfo.download_url_win || 'https://proia.com.br';
        shell.openExternal(url);
      }
    });
    menuItems.push({ type: 'separator' });
  }

  menuItems.push(
    { label: '⚙️  Configurações', click: () => { mainWindow && mainWindow.show(); } },
    { label: '🖨️  Imprimir Teste', click: () => { printerService && printerService.printTest(); } },
    { label: '🔄  Verificar Atualizações', click: () => { checkForUpdates(); } },
    { type: 'separator' },
    { label: '❌  Encerrar', click: () => { isQuitting = true; app.quit(); } }
  );

  const contextMenu = Menu.buildFromTemplate(menuItems);
  tray.setContextMenu(contextMenu);
  tray.setToolTip(`ProIA Delivery Print - ${statusLabels[status] || 'Aguardando'}`);
}

// ============================================
// NOTIFICAÇÕES
// ============================================
function showNotification(title, body) {
  if (Notification.isSupported()) {
    new Notification({ title, body, silent: false }).show();
  }
}

// ============================================
// IPC — COMUNICAÇÃO ENTRE INTERFACE E BACKEND
// ============================================

// Carregar config
ipcMain.handle('get-config', () => {
  return store.store;
});

// Salvar config
ipcMain.handle('save-config', async (event, config) => {
  Object.keys(config).forEach(key => {
    store.set(key, config[key]);
  });
  store.set('configured', true);

  // Atualiza auto-start
  if (config.autoStart) {
    try { await autoLauncher.enable(); } catch (e) { console.log('Auto-launch enable error:', e); }
  } else {
    try { await autoLauncher.disable(); } catch (e) { console.log('Auto-launch disable error:', e); }
  }

  // Reinicia o serviço de impressão com novas configs
  if (printerService) {
    printerService.stop();
  }
  startPrinterService();

  return { success: true };
});

// Listar impressoras do sistema
ipcMain.handle('get-printers', async () => {
  if (mainWindow) {
    const printers = mainWindow.webContents.getPrintersInfo ?
      mainWindow.webContents.getPrintersInfo() : [];
    return printers;
  }
  return [];
});

// Imprimir teste
ipcMain.handle('print-test', async () => {
  if (printerService) {
    try {
      await printerService.printTest();
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
  return { success: false, error: 'Serviço não iniciado' };
});

// Reimprimir pedido (segunda via)
ipcMain.handle('reprint-order', async (event, pedidoId, isSegundaVia) => {
  if (printerService) {
    try {
      await printerService.reprintOrder(pedidoId, isSegundaVia);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
  return { success: false, error: 'Serviço não iniciado' };
});

// Window controls (titlebar buttons)
ipcMain.handle('minimize-window', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.handle('close-window', () => {
  if (mainWindow) mainWindow.hide();
});

// Status do serviço
ipcMain.handle('get-status', () => {
  return {
    running: printerService ? printerService.isRunning : false,
    status: printerService ? (printerService._currentStatus || (printerService.isRunning ? 'conectado' : 'desconectado')) : 'desconectado',
    configured: store.get('configured')
  };
});

// Verificação de Atualizações
ipcMain.handle('check-updates', async () => {
  return await checkForUpdates();
});

// Abrir Link Externo
ipcMain.handle('open-external-url', async (event, url) => {
  if (url) {
    try {
      await shell.openExternal(url);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
  return { success: false, error: 'URL inválida' };
});

// ============================================
// SERVIÇO DE IMPRESSÃO
// ============================================
function startPrinterService() {
  const config = store.store;

  if (!config.empresaId) {
    console.log('⚠️ Configuração incompleta. Aguardando setup...');
    updateTrayMenu('desconectado');
    return;
  }

  printerService = new PrinterService({
    supabaseUrl: SUPABASE_URL,
    supabaseKey: SUPABASE_KEY,
    supabaseAnonKey: SUPABASE_ANON_KEY,
    empresaId: config.empresaId,
    nomeLoja: config.nomeLoja,
    logoPath: config.logoPath,
    fontSize: config.fontSize,
    paperWidth: config.paperWidth,
    extraLines: config.extraLines,
    copies: config.copies,
    printerName: config.printerName,
    onStatusChange: (status) => {
      updateTrayMenu(status);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('status-change', status);
      }
    },
    onPrint: (pedidoId) => {
      showNotification('Pedido Impresso!', `Pedido #${pedidoId} foi impresso com sucesso.`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pedido-impresso', pedidoId);
      }
    },
    onError: (error) => {
      showNotification('Erro de Impressão', error);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('print-error', error);
      }
    }
  });

  printerService.start();
}

// ============================================
// APP LIFECYCLE
// ============================================
app.whenReady().then(() => {
  // No macOS, substitui o ícone padrão do Electron (átomo) pela logo do app
  if (process.platform === 'darwin' && app.dock) {
    try {
      const iconImage = nativeImage.createFromPath(
        path.join(__dirname, 'assets', 'icon512x512-dark.png')
      );
      if (!iconImage.isEmpty()) {
        app.dock.setIcon(iconImage);
        console.log('✅ Ícone do Dock atualizado!');
      } else {
        console.log('⚠️ Imagem do ícone está vazia');
      }
    } catch (e) {
      console.log('⚠️ Erro ao definir ícone do dock:', e.message);
    }
  }

  // Define o nome do app na barra de menu (macOS)
  app.setName('ProIA Delivery Print');

  createWindow();
  createTray();

  // Se já estiver configurado, inicia o serviço direto
  if (store.get('configured')) {
    startPrinterService();
  }

  // Checagem de atualizações: 4 segundos após inicialização e a cada 30 minutos
  setTimeout(() => {
    checkForUpdates();
  }, 4000);
  setInterval(() => {
    checkForUpdates();
  }, 30 * 60 * 1000);
});

app.on('window-all-closed', () => {
  // Não fecha o app, fica rodando no tray
  // O Electron não quits quando todas as janelas fecham
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  } else {
    mainWindow.show();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  if (printerService) {
    printerService.stop();
  }
});
