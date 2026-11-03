// ============================================
// RENDERER — Lógica da Interface
// ============================================

document.addEventListener('DOMContentLoaded', async () => {
  // ============================================
  // ELEMENTOS
  // ============================================
  const elements = {
    // Inputs
    nomeLoja: document.getElementById('nomeLoja'),
    empresaId: document.getElementById('empresaId'),
    extraLines: document.getElementById('extraLines'),
    extraLinesValue: document.getElementById('extraLines-value'),
    copies: document.getElementById('copies'),
    copiesValue: document.getElementById('copies-value'),
    autoStart: document.getElementById('autoStart'),

    // Buttons
    btnSave: document.getElementById('btn-save'),
    btnTest: document.getElementById('btn-test'),
    btnMinimize: document.getElementById('btn-minimize'),
    btnClose: document.getElementById('btn-close'),

    // Status
    statusDot: document.getElementById('status-dot'),
    statusText: document.getElementById('status-text'),

    // Toast
    toast: document.getElementById('toast'),
    toastIcon: document.getElementById('toast-icon'),
    toastText: document.getElementById('toast-text'),

    // Screens
    screenSetup: document.getElementById('screen-setup'),
    screenDashboard: document.getElementById('screen-dashboard'),
  };

  // State
  let selectedFontSize = 'media';
  let selectedPaperWidth = '80';
  let printCount = 0;
  let printLog = [];

  // ============================================
  // CARREGAR CONFIG SALVA
  // ============================================
  async function loadConfig() {
    try {
      const config = await window.api.getConfig();

      if (config.nomeLoja) elements.nomeLoja.value = config.nomeLoja;
      if (config.empresaId) elements.empresaId.value = config.empresaId;
      if (config.extraLines !== undefined) {
        elements.extraLines.value = config.extraLines;
        elements.extraLinesValue.textContent = config.extraLines;
      }
      if (config.copies !== undefined) {
        elements.copies.value = config.copies;
        elements.copiesValue.textContent = config.copies;
      }
      if (config.autoStart !== undefined) {
        elements.autoStart.checked = config.autoStart;
      }

      // Font size
      if (config.fontSize) {
        selectedFontSize = config.fontSize;
        updateSelectButtons('fontSize', selectedFontSize);
      }

      // Paper width
      if (config.paperWidth) {
        selectedPaperWidth = config.paperWidth;
        updateSelectButtons('paperWidth', selectedPaperWidth);
      }

      // Atualiza badges do dashboard
      const dashCopiesStat = document.getElementById('dash-copies-stat');
      if (dashCopiesStat) dashCopiesStat.textContent = config.copies || 1;
      const dashEmpresaStat = document.getElementById('dash-empresa-stat');
      if (dashEmpresaStat) dashEmpresaStat.textContent = config.empresaId ? `#${config.empresaId}` : '#--';

      // Atualiza status inicial imediatamente (evita ficar 'Conectando...' ou 'Reconectando...')
      try {
        const statusInfo = await window.api.getStatus();
        if (statusInfo && statusInfo.running) {
          applyStatusUI(statusInfo.status || 'conectado');
        }
      } catch (e) { }

      // Se já configurado, vai direto pro dashboard
      if (config.configured) {
        showScreen('dashboard');
      }
    } catch (e) {
      console.error('Erro ao carregar config:', e);
    }
  }

  // ============================================
  // SELECT BUTTONS (Fonte / Papel)
  // ============================================
  function updateSelectButtons(field, value) {
    document.querySelectorAll(`[data-field="${field}"]`).forEach(btn => {
      btn.classList.toggle('active', btn.dataset.value === value);
    });
  }

  document.querySelectorAll('.select-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const field = btn.dataset.field;
      const value = btn.dataset.value;

      if (field === 'fontSize') selectedFontSize = value;
      if (field === 'paperWidth') selectedPaperWidth = value;

      updateSelectButtons(field, value);
    });
  });

  // ============================================
  // RANGE SLIDER
  // ============================================
  elements.extraLines.addEventListener('input', (e) => {
    elements.extraLinesValue.textContent = e.target.value;
  });

  elements.copies.addEventListener('input', (e) => {
    elements.copiesValue.textContent = e.target.value;
  });



  // ============================================
  // TITLEBAR BUTTONS
  // ============================================
  elements.btnMinimize.addEventListener('click', () => {
    window.api.minimizeWindow();
  });

  elements.btnClose.addEventListener('click', () => {
    window.api.closeWindow();
  });

  // ============================================
  // SALVAR CONFIGURAÇÃO
  // ============================================
  elements.btnSave.addEventListener('click', async () => {
    const config = {
      nomeLoja: elements.nomeLoja.value.trim(),
      empresaId: elements.empresaId.value.trim(),
      fontSize: selectedFontSize,
      paperWidth: selectedPaperWidth,
      extraLines: parseInt(elements.extraLines.value),
      copies: parseInt(elements.copies.value),
      autoStart: elements.autoStart.checked,
    };

    // Validação
    if (!config.empresaId) {
      showToast('Informe o ID da Empresa', 'error');
      elements.empresaId.focus();
      return;
    }

    // Loading state
    elements.btnSave.classList.add('loading');
    elements.btnSave.innerHTML = '⏳ Salvando...';

    try {
      const result = await window.api.saveConfig(config);
      if (result.success) {
        const dashCopiesStat = document.getElementById('dash-copies-stat');
        if (dashCopiesStat) dashCopiesStat.textContent = config.copies || 1;
        const dashEmpresaStat = document.getElementById('dash-empresa-stat');
        if (dashEmpresaStat) dashEmpresaStat.textContent = config.empresaId ? `#${config.empresaId}` : '#--';

        showToast('Configuração salva! Iniciando serviço...', 'success');
        setTimeout(() => showScreen('dashboard'), 800);
      } else {
        showToast('Erro ao salvar', 'error');
      }
    } catch (e) {
      showToast('Erro: ' + e.message, 'error');
    } finally {
      elements.btnSave.classList.remove('loading');
      elements.btnSave.innerHTML = '✅ Salvar e Iniciar';
    }
  });

  // ============================================
  // IMPRIMIR TESTE
  // ============================================
  elements.btnTest.addEventListener('click', async () => {
    elements.btnTest.classList.add('loading');
    elements.btnTest.innerHTML = '⏳ Imprimindo...';

    try {
      // Salva a configuração atual da tela para que o teste reflita exatamente a fonte e papel selecionados
      const currentConfig = {
        nomeLoja: elements.nomeLoja.value.trim(),
        empresaId: elements.empresaId.value.trim(),
        fontSize: selectedFontSize,
        paperWidth: selectedPaperWidth,
        extraLines: parseInt(elements.extraLines.value),
        copies: parseInt(elements.copies.value),
        autoStart: elements.autoStart.checked,
      };
      if (currentConfig.empresaId) {
        await window.api.saveConfig(currentConfig);
      }

      const result = await window.api.printTest();
      if (result.success) {
        showToast('Impressão de teste enviada!', 'success');
      } else {
        showToast('Erro: ' + (result.error || 'Falha na impressão'), 'error');
      }
    } catch (e) {
      showToast('Erro: ' + e.message, 'error');
    } finally {
      elements.btnTest.classList.remove('loading');
      elements.btnTest.innerHTML = '🖨️ Imprimir Teste';
    }
  });

  // ============================================
  // DASHBOARD — Botões
  // ============================================
  const btnDashTest = document.getElementById('btn-dash-test');
  if (btnDashTest) {
    btnDashTest.addEventListener('click', async () => {
      btnDashTest.classList.add('loading');
      try {
        const result = await window.api.printTest();
        if (result.success) {
          showToast('Teste enviado!', 'success');
        } else {
          showToast('Erro: ' + (result.error || 'Falha'), 'error');
        }
      } catch (e) {
        showToast('Erro: ' + e.message, 'error');
      } finally {
        btnDashTest.classList.remove('loading');
      }
    });
  }

  const btnSettings = document.getElementById('btn-settings');
  if (btnSettings) {
    btnSettings.addEventListener('click', () => {
      showScreen('setup');
    });
  }

  // Reimprimir pedido por ID
  const btnReprint = document.getElementById('btn-reprint');
  const inputReprintId = document.getElementById('reprint-pedido-id');
  if (btnReprint && inputReprintId) {
    btnReprint.addEventListener('click', async () => {
      const pedidoId = inputReprintId.value.trim();
      if (!pedidoId) {
        showToast('Informe o ID do pedido', 'error');
        inputReprintId.focus();
        return;
      }
      btnReprint.classList.add('loading');
      btnReprint.innerHTML = '⏳...';
      try {
        const result = await window.api.reprintOrder(pedidoId, true);
        if (result.success) {
          showToast(`Reimpressão do Pedido #${pedidoId} enviada!`, 'success');
          inputReprintId.value = '';
        } else {
          showToast('Erro: ' + (result.error || 'Falha'), 'error');
        }
      } catch (e) {
        showToast('Erro: ' + e.message, 'error');
      } finally {
        btnReprint.classList.remove('loading');
        btnReprint.innerHTML = 'Reimprimir';
      }
    });
  }

  // ============================================
  // TELAS (Setup <-> Dashboard)
  // ============================================
  function showScreen(name) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const target = document.getElementById(`screen-${name}`);
    if (target) target.classList.add('active');
  }

  // ============================================
  // TOAST NOTIFICATIONS
  // ============================================
  let toastTimeout = null;

  function showToast(message, type = 'success') {
    if (toastTimeout) clearTimeout(toastTimeout);

    elements.toastIcon.textContent = type === 'success' ? '✅' : '❌';
    elements.toastText.textContent = message;
    elements.toast.className = `toast show ${type}`;

    toastTimeout = setTimeout(() => {
      elements.toast.className = 'toast';
    }, 3000);
  }

  // ============================================
  // EVENTOS DO BACKEND
  // ============================================
  function applyStatusUI(status) {
    const labels = {
      'conectado': 'Conectado — Aguardando pedidos',
      'reconectando': 'Reconectando...',
      'desconectado': 'Desconectado',
      'erro': 'Erro na conexão',
    };

    elements.statusText.textContent = labels[status] || status;

    // Update dot
    elements.statusDot.className = 'status-dot';
    if (status === 'conectado') elements.statusDot.classList.add('connected');
    if (status === 'erro') elements.statusDot.classList.add('error');

    // Update dashboard indicator
    const dashIndicator = document.getElementById('dash-status-indicator');
    const dashStatusText = document.getElementById('dash-status-text');
    if (dashIndicator) {
      dashIndicator.className = 'dash-status-indicator';
      if (status === 'conectado') dashIndicator.classList.add('connected');
      if (status === 'reconectando') dashIndicator.classList.add('reconnecting');
      if (status === 'erro' || status === 'desconectado') dashIndicator.classList.add('disconnected');
    }
    if (dashStatusText) {
      dashStatusText.textContent = labels[status] || status;
    }
  }

  window.api.onStatusChange((status) => {
    applyStatusUI(status);
  });

  window.api.onPedidoImpresso((pedidoId) => {
    printCount++;
    showToast(`Pedido #${pedidoId} impresso!`, 'success');

    // Update dashboard counter
    const counter = document.getElementById('print-counter');
    if (counter) counter.textContent = printCount;

    // Add to log
    addLogEntry(pedidoId);
  });

  window.api.onPrintError((error) => {
    showToast('Erro: ' + error, 'error');
    addLogEntry(null, error);
  });

  // ============================================
  // LOG DE IMPRESSÕES
  // ============================================
  function addLogEntry(pedidoId, error = null) {
    const logContainer = document.getElementById('print-log');
    if (!logContainer) return;

    const now = new Date().toLocaleTimeString('pt-BR');
    const entry = document.createElement('div');
    entry.className = `log-entry ${error ? 'log-error' : 'log-success'}`;

    if (error) {
      entry.innerHTML = `<span class="log-time">${now}</span> <span class="log-icon">❌</span> Erro: ${error}`;
    } else {
      entry.innerHTML = `<span class="log-time">${now}</span> <span class="log-icon">✅</span> <span>Pedido #${pedidoId} impresso</span> <button class="btn-reprint-log" data-id="${pedidoId}" title="Reimprimir Pedido (2ª Via)">🔄</button>`;
      
      const btnReprintLog = entry.querySelector('.btn-reprint-log');
      if (btnReprintLog) {
        btnReprintLog.addEventListener('click', async (e) => {
          e.stopPropagation();
          btnReprintLog.innerHTML = '⏳';
          btnReprintLog.style.pointerEvents = 'none';
          try {
            const result = await window.api.reprintOrder(pedidoId, true);
            if (result.success) {
              showToast(`Reimpressão do Pedido #${pedidoId} enviada!`, 'success');
            } else {
              showToast('Erro: ' + (result.error || 'Falha'), 'error');
            }
          } catch (err) {
            showToast('Erro: ' + err.message, 'error');
          } finally {
            btnReprintLog.innerHTML = '🔄';
            btnReprintLog.style.pointerEvents = 'auto';
          }
        });
      }
    }

    // Insert at the top
    logContainer.insertBefore(entry, logContainer.firstChild);

    // Keep only last 20 entries
    while (logContainer.children.length > 20) {
      logContainer.removeChild(logContainer.lastChild);
    }

    printLog.unshift({ pedidoId, error, time: now });
  }

  // ============================================
  // NOTIFICAÇÃO DE ATUALIZAÇÃO DISPONÍVEL
  // ============================================
  const updateBanner = document.getElementById('update-banner');
  const updateTitle = document.getElementById('update-banner-title');
  const updateSub = document.getElementById('update-banner-sub');
  const btnUpdateAction = document.getElementById('btn-update-action');
  let currentUpdateUrl = 'https://github.com/gutodourado2/impressoraProIa';

  function handleUpdateAvailable(data) {
    if (!data || !updateBanner) return;
    if (updateTitle) updateTitle.textContent = `Nova versão v${data.versao} disponível!`;
    if (updateSub && data.novidades) updateSub.textContent = data.novidades;
    
    const isMac = navigator.userAgent.toLowerCase().includes('mac');
    if (isMac && data.download_url_mac_arm) {
      currentUpdateUrl = data.download_url_mac_arm;
    } else if (!isMac && data.download_url_win) {
      currentUpdateUrl = data.download_url_win;
    }

    updateBanner.classList.remove('hidden');
  }

  if (window.api && window.api.onUpdateAvailable) {
    window.api.onUpdateAvailable(handleUpdateAvailable);
  }

  if (btnUpdateAction) {
    btnUpdateAction.addEventListener('click', () => {
      if (window.api && window.api.openExternalUrl) {
        window.api.openExternalUrl(currentUpdateUrl);
      }
    });
  }

  // ============================================
  // INIT
  // ============================================
  await loadConfig();
});
