const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

// ============================================
// FILA ASSÍNCRONA SEQUENCIAL (FIFO QUEUE)
// Impede que múltiplos pedidos atropelem a impressora térmica
// ============================================
class AsyncQueue {
  constructor() {
    this._queue = [];
    this._processing = false;
  }

  push(task) {
    return new Promise((resolve, reject) => {
      this._queue.push({ task, resolve, reject });
      this._processNext();
    });
  }

  async _processNext() {
    if (this._processing || this._queue.length === 0) return;
    this._processing = true;

    const { task, resolve, reject } = this._queue.shift();
    try {
      const result = await task();
      resolve(result);
    } catch (err) {
      reject(err);
    } finally {
      this._processing = false;
      this._processNext();
    }
  }

  size() {
    return this._queue.length + (this._processing ? 1 : 0);
  }
}

// ============================================
// PRINTER SERVICE — Motor Profissional de Impressão v2.0.2
// ============================================
class PrinterService {
  constructor(config) {
    this.config = config;
    this.supabase = null;
    this.supabaseRealtime = null;
    this.channel = null;
    this.isRunning = false;

    // Fila sequencial de execução
    this.queue = new AsyncQueue();

    // Controles de concorrência e deduplicação em memória
    this.processingFilaIds = new Set();
    this.recentlyPrintedFilaIds = new Map(); // filaId -> timestamp
    this.recentlyPrintedPedidoIds = new Map(); // pedidoId -> timestamp

    // Gerenciamento de sincronização inteligente
    this._pollingTimer = null;
    this._isPolling = false;
    this._reconnectTimer = null;
    this._reconnectAttempts = 0;
    this._stopped = false;
    this.realtimeStatus = 'DISCONNECTED';

    console.log('[PrinterService v2.0.2 Enterprise] Inicializado para Empresa #' + (config.empresaId || 'N/A'));
  }

  // Limpa IDs de pedidos antigos da memória para evitar vazamento
  _cleanOldMemoryCache() {
    const fifteenMinutesAgo = Date.now() - 15 * 60 * 1000;
    for (const [id, time] of this.recentlyPrintedFilaIds.entries()) {
      if (time < fifteenMinutesAgo) this.recentlyPrintedFilaIds.delete(id);
    }
    for (const [id, time] of this.recentlyPrintedPedidoIds.entries()) {
      if (time < fifteenMinutesAgo) this.recentlyPrintedPedidoIds.delete(id);
    }
  }

  // Remove acentos para impressoras térmicas
  removeAcentos(str) {
    if (!str || this.isVazio(str)) return '';
    return String(str)
      .replace(/[áàâãä]/gi, 'a')
      .replace(/[éèêë]/gi, 'e')
      .replace(/[íìîï]/gi, 'i')
      .replace(/[óòôõö]/gi, 'o')
      .replace(/[úùûü]/gi, 'u')
      .replace(/[ç]/gi, 'c')
      .replace(/[ñ]/gi, 'n');
  }

  // Verifica se valor é nulo/vazio
  isVazio(val) {
    if (val === null || val === undefined) return true;
    if (typeof val === 'string') {
      const limpo = val.trim().toLowerCase();
      if (limpo === '' || limpo === 'null' || limpo === 'undefined') return true;
      if (limpo.replace(/null/g, '').replace(/[,\-\s]/g, '').length === 0) return true;
    }
    return false;
  }

  // Tamanho base da fonte ESC/POS (controla o corpo do cupom)
  getFontCommand() {
    switch (this.config.fontSize) {
      case 'pequena':
        return Buffer.from([0x1B, 0x21, 0x00]); // Font A Normal (12x24) - compacto e 100% legível
      case 'grande':
        return Buffer.from([0x1B, 0x21, 0x18]); // Font A Dupla Altura + Negrito (12x48) - grande e bem destacado
      default: // media
        return Buffer.from([0x1B, 0x21, 0x08]); // Font A Negrito (12x24) - encorpado, nítido e com alto contraste
    }
  }

  // Largura do separador baseado no papel
  getSeparator() {
    return this.config.paperWidth === '58'
      ? '--------------------------------'
      : '================================================';
  }

  getDoubleSeparator() {
    return this.config.paperWidth === '58'
      ? '================================'
      : '================================================';
  }

  // Detecta impressora USB (Mac/Linux)
  detectPrinterDevice() {
    if (process.platform === 'win32') return null;

    try {
      const files = fs.readdirSync('/dev');
      const usbModem = files.find(f => f.startsWith('cu.usbmodem'));
      if (usbModem) return '/dev/' + usbModem;

      const usbSerial = files.find(f => f.startsWith('cu.usbserial'));
      if (usbSerial) return '/dev/' + usbSerial;
    } catch (e) { /* ignore */ }

    return null;
  }

  // Envia dados para impressora via USB direto (Mac/Linux)
  async printViaUSB(devicePath, buffer) {
    return new Promise((resolve, reject) => {
      const stream = fs.createWriteStream(devicePath);
      stream.on('open', () => {
        stream.write(buffer, () => {
          setTimeout(() => { stream.end(); resolve(); }, 1200);
        });
      });
      stream.on('error', reject);
    });
  }

  // Envia via CUPS lp (Mac/Linux fallback)
  async printViaLP(buffer) {
    const tmpPath = path.join(os.tmpdir(), 'cupom_' + Date.now() + '.bin');
    fs.writeFileSync(tmpPath, buffer);
    return new Promise((resolve, reject) => {
      const printerOpt = this.config.printerName
        ? '-d "' + this.config.printerName + '"'
        : '';
      exec('lp -o raw ' + printerOpt + ' "' + tmpPath + '"', (error, stdout) => {
        try { fs.unlinkSync(tmpPath); } catch (e) { }
        if (error) return reject(error);
        resolve(stdout);
      });
    });
  }

  // ============================================
  // WINDOWS RAW PRINTING (winspool.Drv)
  // ============================================
  _detectWindowsPort(printerName) {
    return new Promise((resolve) => {
      const filter = printerName
        ? "Name='" + printerName.replace(/'/g, "''") + "'"
        : "Default=TRUE";
      const cmd = 'wmic printer where "' + filter + '" get PortName /value';
      exec(cmd, { shell: 'cmd.exe', timeout: 10000 }, (err, stdout) => {
        const match = (stdout || '').match(/PortName=(\S+)/);
        resolve(match ? match[1].trim() : '');
      });
    });
  }

  _getCSharpSource() {
    const lines = [
      'using System;',
      'using System.Runtime.InteropServices;',
      'public class RawPH {',
      '    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]',
      '    public class DOCINFOA {',
      '        [MarshalAs(UnmanagedType.LPStr)] public string pDocName;',
      '        [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;',
      '        [MarshalAs(UnmanagedType.LPStr)] public string pDataType;',
      '    }',
      '    [DllImport("winspool.Drv", EntryPoint = "OpenPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]',
      '    public static extern bool OpenPrinter([MarshalAs(UnmanagedType.LPStr)] string szPrinter, out IntPtr hPrinter, IntPtr pd);',
      '    [DllImport("winspool.Drv", EntryPoint = "ClosePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]',
      '    public static extern bool ClosePrinter(IntPtr hPrinter);',
      '    [DllImport("winspool.Drv", EntryPoint = "StartDocPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]',
      '    public static extern bool StartDocPrinter(IntPtr hPrinter, Int32 level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);',
      '    [DllImport("winspool.Drv", EntryPoint = "EndDocPrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]',
      '    public static extern bool EndDocPrinter(IntPtr hPrinter);',
      '    [DllImport("winspool.Drv", EntryPoint = "StartPagePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]',
      '    public static extern bool StartPagePrinter(IntPtr hPrinter);',
      '    [DllImport("winspool.Drv", EntryPoint = "EndPagePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]',
      '    public static extern bool EndPagePrinter(IntPtr hPrinter);',
      '    [DllImport("winspool.Drv", EntryPoint = "WritePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]',
      '    public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, Int32 dwCount, out Int32 dwWritten);',
      '    public static bool SendRaw(string printerName, byte[] data) {',
      '        IntPtr pBytes = Marshal.AllocCoTaskMem(data.Length);',
      '        Marshal.Copy(data, 0, pBytes, data.Length);',
      '        bool ok = false;',
      '        IntPtr hPrn = IntPtr.Zero;',
      '        DOCINFOA di = new DOCINFOA();',
      '        di.pDocName = "ProIA RAW";',
      '        di.pDataType = "RAW";',
      '        if (OpenPrinter(printerName, out hPrn, IntPtr.Zero)) {',
      '            if (StartDocPrinter(hPrn, 1, di)) {',
      '                if (StartPagePrinter(hPrn)) {',
      '                    Int32 written = 0;',
      '                    ok = WritePrinter(hPrn, pBytes, data.Length, out written);',
      '                    EndPagePrinter(hPrn);',
      '                }',
      '                EndDocPrinter(hPrn);',
      '            }',
      '            ClosePrinter(hPrn);',
      '        }',
      '        Marshal.FreeCoTaskMem(pBytes);',
      '        return ok;',
      '    }',
      '}'
    ];
    return lines.join('\r\n');
  }

  _winPrintRawCSharp(filePath, printerName) {
    const self = this;
    return new Promise((resolve, reject) => {
      const safePath = filePath.replace(/\\/g, '\\\\').replace(/'/g, "''");
      const safePrinter = (printerName || '').replace(/'/g, "''");
      const csSrc = self._getCSharpSource();

      const ps = [
        '$ErrorActionPreference = "Stop"',
        '',
        '$cs = @"',
        csSrc,
        '"@',
        '',
        'try { Add-Type -TypeDefinition $cs } catch {',
        '  if ($_.Exception.Message -notlike "*already exists*") { throw }',
        '}',
        '',
        "$data = [System.IO.File]::ReadAllBytes('" + safePath + "')",
        '',
        "$pn = '" + safePrinter + "'",
        'if ([string]::IsNullOrWhiteSpace($pn)) {',
        '  $dp = Get-CimInstance -ClassName Win32_Printer -Filter "Default=True"',
        '  if ($dp) { $pn = $dp.Name }',
        '}',
        '',
        'if ([string]::IsNullOrWhiteSpace($pn)) {',
        '  throw "Nenhuma impressora encontrada"',
        '}',
        '',
        'Write-Host "Impressora: $pn | Bytes: $($data.Length)"',
        '$ok = [RawPH]::SendRaw($pn, $data)',
        'if (-not $ok) {',
        '  $e = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()',
        '  throw "SendRaw FALHOU - Win32 erro: $e"',
        '}',
        'Write-Host "OK"'
      ];

      const scriptContent = ps.join('\r\n');
      const scriptPath = path.join(os.tmpdir(), 'proia_raw_' + Date.now() + '.ps1');
      const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
      const body = Buffer.from(scriptContent, 'utf8');
      fs.writeFileSync(scriptPath, Buffer.concat([bom, body]));

      const cmd = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + scriptPath + '"';
      exec(cmd, { shell: 'cmd.exe', timeout: 30000 }, (error, stdout, stderr) => {
        console.log('[WIN-RAW] ' + (stdout || '').trim());
        if (stderr) console.log('[WIN-RAW-ERR] ' + stderr.trim());
        try { fs.unlinkSync(scriptPath); } catch (e) { }
        if (error) {
          return reject(new Error('C# RAW falhou: ' + (stderr || error.message)));
        }
        resolve();
      });
    });
  }

  _winPrintCopyPort(filePath, printerName) {
    const self = this;
    return new Promise((resolve, reject) => {
      self._detectWindowsPort(printerName).then((portName) => {
        if (!portName) return reject(new Error('Porta não encontrada'));
        console.log('[WIN-PORT] Porta: ' + portName);
        const copyCmd = 'copy /b "' + filePath + '" "\\\\.\\' + portName + '"';
        exec(copyCmd, { shell: 'cmd.exe', timeout: 15000 }, (err) => {
          if (err) return reject(new Error('COPY /B falhou: ' + err.message));
          resolve();
        });
      });
    });
  }

  async printViaWindows(buffer) {
    console.log('[WIN-PRINT] Enviando ' + buffer.length + ' bytes');
    const tmpPath = path.join(os.tmpdir(), 'cupom_' + Date.now() + '.bin');
    fs.writeFileSync(tmpPath, buffer);
    const printerName = this.config.printerName || '';
    const errors = [];

    // Estratégia 1: C# RawPrinterHelper
    try {
      await this._winPrintRawCSharp(tmpPath, printerName);
      console.log('[WIN-PRINT] ✅ C# RAW OK!');
      try { fs.unlinkSync(tmpPath); } catch (e) { }
      return;
    } catch (e) {
      console.log('[WIN-PRINT] ❌ C# RAW falhou: ' + e.message);
      errors.push(e.message);
    }

    // Estratégia 2: COPY /B para porta
    try {
      await this._winPrintCopyPort(tmpPath, printerName);
      console.log('[WIN-PRINT] ✅ COPY /B OK!');
      try { fs.unlinkSync(tmpPath); } catch (e) { }
      return;
    } catch (e) {
      console.log('[WIN-PRINT] ❌ COPY /B falhou: ' + e.message);
      errors.push(e.message);
    }

    try { fs.unlinkSync(tmpPath); } catch (e) { }
    throw new Error('Impressão Windows falhou: ' + errors.join(' | '));
  }

  async sendToPrinter(buffer) {
    if (process.platform === 'win32') {
      await this.printViaWindows(buffer);
    } else {
      const device = this.detectPrinterDevice();
      if (device) {
        try {
          await this.printViaUSB(device, buffer);
        } catch (e) {
          console.log('⚠️ USB direto falhou, tentando via CUPS...');
          await this.printViaLP(buffer);
        }
      } else {
        await this.printViaLP(buffer);
      }
    }
  }

  // ============================================
  // MONTAGEM DO CUPOM (ESC/POS)
  // ============================================
  buildReceipt(compra, itens, usuario = null, isSegundaVia = false) {
    const parts = [];
    const sep = this.getSeparator();
    const dsep = this.getDoubleSeparator();
    const fontCmd = this.getFontCommand();
    const isGrande = this.config.fontSize === 'grande';
    const isPequena = this.config.fontSize === 'pequena';
    const is80mm = String(this.config.paperWidth) === '80';

    // Reset impressora
    parts.push(Buffer.from([0x1B, 0x40]));
    // Code Page PC437
    parts.push(Buffer.from([0x1B, 0x74, 0x00]));

    // --- SEGUNDA VIA CABEÇALHO ---
    if (isSegundaVia) {
      parts.push(Buffer.from([0x1B, 0x61, 0x01])); // Centralizar
      parts.push(Buffer.from([0x1B, 0x21, 0x30])); // Negrito + Duplo
      parts.push(Buffer.from('*** SEGUNDA VIA ***\n', 'ascii'));
      parts.push(Buffer.from([0x1B, 0x21, 0x00])); // Reset
      parts.push(Buffer.from(dsep + '\n', 'ascii'));
    }

    // --- CABEÇALHO: Nome da Loja ---
    parts.push(Buffer.from([0x1B, 0x61, 0x01])); // Centralizar

    if (this.config.nomeLoja && !this.isVazio(this.config.nomeLoja)) {
      parts.push(Buffer.from([0x1B, 0x21, 0x30])); // Negrito + Duplo
      parts.push(Buffer.from(this.removeAcentos(this.config.nomeLoja) + '\n', 'ascii'));
      parts.push(Buffer.from([0x1B, 0x21, 0x00])); // Reset
    }

    parts.push(Buffer.from([0x1B, 0x21, 0x00]));
    parts.push(Buffer.from(dsep + '\n', 'ascii'));

    // Título NOVO PEDIDO
    parts.push(Buffer.from([0x1B, 0x21, 0x30])); // Negrito + Duplo
    parts.push(Buffer.from('NOVO PEDIDO\n', 'ascii'));
    parts.push(Buffer.from([0x1B, 0x21, 0x00]));

    parts.push(Buffer.from('#' + compra.id + '\n', 'ascii'));
    parts.push(Buffer.from(dsep + '\n', 'ascii'));

    // Alinhar esquerda + fonte selecionada
    parts.push(Buffer.from([0x1B, 0x61, 0x00]));
    parts.push(fontCmd);

    // --- DATA ---
    const dataConvertida = compra.created_at
      ? new Date(compra.created_at).toLocaleString('pt-BR')
      : new Date().toLocaleString('pt-BR');
    parts.push(Buffer.from('Data: ' + dataConvertida + '\n', 'ascii'));
    parts.push(Buffer.from([0x1B, 0x21, 0x00]));
    parts.push(Buffer.from(dsep + '\n', 'ascii'));

    // --- CLIENTE ---
    let clienteNome = 'Cliente';
    if (usuario && usuario.nome) {
      clienteNome = usuario.nome;
    } else if (compra.nome_cliente) {
      clienteNome = compra.nome_cliente;
    }

    let contactLabel = 'Contato';
    let clienteContato = 'Nao informado';

    if (usuario && usuario.telefone) {
      clienteContato = usuario.telefone;
      contactLabel = 'Tel';
    } else if (compra.telefone_cliente) {
      clienteContato = compra.telefone_cliente;
      contactLabel = 'Tel';
    } else if (usuario && usuario.email) {
      clienteContato = usuario.email;
      contactLabel = 'E-mail';
    }

    parts.push(Buffer.from([0x1B, 0x61, 0x00]));
    parts.push(Buffer.from([0x1B, 0x21, 0x08])); // Negrito
    parts.push(Buffer.from('CLIENTE:\n', 'ascii'));

    // Nome do cliente em destaque proporcional ao papel e tamanho
    let clienteFontCmd;
    if (isGrande) {
      clienteFontCmd = Buffer.from([0x1B, 0x21, 0x38]); // Duplo Altura + Duplo Largura + Negrito
    } else if (isPequena) {
      clienteFontCmd = Buffer.from([0x1B, 0x21, 0x08]); // Negrito
    } else {
      // media (padrão)
      clienteFontCmd = is80mm
        ? Buffer.from([0x1B, 0x21, 0x30]) // Dupla Altura + Largura em 80mm
        : Buffer.from([0x1B, 0x21, 0x18]); // Dupla Altura + Negrito em 58mm (evita quebrar nomes longos)
    }
    parts.push(clienteFontCmd);
    parts.push(Buffer.from('Nome: ' + this.removeAcentos(clienteNome) + '\n', 'ascii'));

    parts.push(fontCmd);
    if (clienteContato !== 'Nao informado') {
      parts.push(Buffer.from(contactLabel + ': ' + this.removeAcentos(clienteContato) + '\n', 'ascii'));
    }
    parts.push(Buffer.from([0x1B, 0x21, 0x00]));
    parts.push(Buffer.from(dsep + '\n', 'ascii'));

    // --- ITENS ---
    const itensHeaderCmd = isGrande
      ? Buffer.from([0x1B, 0x21, 0x18])
      : Buffer.from([0x1B, 0x21, 0x08]);
    parts.push(itensHeaderCmd);
    parts.push(Buffer.from('ITENS DO PEDIDO:\n', 'ascii'));
    parts.push(Buffer.from([0x1B, 0x21, 0x00]));
    parts.push(Buffer.from(sep + '\n', 'ascii'));

    if (itens && itens.length > 0) {
      itens.forEach((item, idx) => {
        const nomeProduto = this.removeAcentos(
          item.produto_nome || (item.produtos ? item.produtos.produto : 'Produto')
        );
        const qtd = item.quantidade || 1;
        const precoUnit = Number(item.preco_unitario || 0).toFixed(2);
        const subtotal = Number(item.subtotal || 0).toFixed(2);

        // Fonte para o Produto + Quantidade (grande destaque na comanda)
        let itemFontCmd;
        if (isGrande) {
          itemFontCmd = is80mm
            ? Buffer.from([0x1B, 0x21, 0x38]) // Dupla largura + dupla altura + negrito em 80mm
            : Buffer.from([0x1B, 0x21, 0x18]); // Dupla altura + negrito em 58mm
        } else if (isPequena) {
          itemFontCmd = Buffer.from([0x1B, 0x21, 0x08]); // Negrito Font A
        } else {
          // media (padrão)
          itemFontCmd = Buffer.from([0x1B, 0x21, 0x18]); // Dupla altura + negrito (fácil leitura na cozinha)
        }

        parts.push(itemFontCmd);
        parts.push(Buffer.from((idx + 1) + '. ' + qtd + 'x ' + nomeProduto + '\n', 'ascii'));

        // Detalhe de preço (usa fonte do corpo configurada)
        parts.push(fontCmd);
        parts.push(Buffer.from('   ' + qtd + ' x R$' + precoUnit + ' = R$' + subtotal + '\n', 'ascii'));

        // Adicionais do item
        if (item.adicionais && item.adicionais.length > 0) {
          let adicionalFontCmd = fontCmd;
          if (isGrande) {
            adicionalFontCmd = Buffer.from([0x1B, 0x21, 0x18]); // Dupla altura nos adicionais em fonte grande
          }
          parts.push(adicionalFontCmd);
          item.adicionais.forEach(ad => {
            const nomeAdicional = this.removeAcentos(ad.nome || 'Adicional');
            const precoAd = Number(ad.preco || 0) > 0
              ? ' (+R$ ' + Number(ad.preco).toFixed(2) + ')'
              : '';
            parts.push(Buffer.from('   [+] ' + (ad.quantidade || 1) + 'x ' + nomeAdicional + precoAd + '\n', 'ascii'));
          });
        }
      });
    } else {
      parts.push(fontCmd);
      parts.push(Buffer.from('Nenhum item informado.\n', 'ascii'));
    }

    parts.push(Buffer.from([0x1B, 0x21, 0x00]));
    parts.push(Buffer.from(sep + '\n', 'ascii'));

    // --- TOTAIS ---
    parts.push(Buffer.from([0x1B, 0x21, 0x08]));
    if (!this.isVazio(compra.valor_total)) {
      parts.push(Buffer.from([0x1B, 0x21, 0x38])); // Grande + Negrito
      parts.push(Buffer.from('TOTAL: R$ ' + Number(compra.valor_total).toFixed(2) + '\n', 'ascii'));
    }
    parts.push(fontCmd);

    if (!this.isVazio(compra.taxa_entrega) && Number(compra.taxa_entrega) > 0) {
      parts.push(Buffer.from('Taxa Entrega: R$ ' + Number(compra.taxa_entrega).toFixed(2) + '\n', 'ascii'));
    }
    if (!this.isVazio(compra.forma_pagamento)) {
      parts.push(Buffer.from('Pgto: ' + this.removeAcentos(compra.forma_pagamento) + '\n', 'ascii'));
    }
    if (!this.isVazio(compra.troco_para) && Number(compra.troco_para) > 0) {
      parts.push(Buffer.from('Troco p/: R$ ' + Number(compra.troco_para).toFixed(2) + '\n', 'ascii'));
    }

    // --- ENDEREÇO ---
    if (!this.isVazio(compra.endereco_entrega)) {
      parts.push(Buffer.from([0x1B, 0x21, 0x00]));
      parts.push(Buffer.from(sep + '\n', 'ascii'));
      parts.push(Buffer.from([0x1B, 0x21, 0x08]));
      parts.push(Buffer.from('ENTREGA:\n', 'ascii'));

      let entregaFontCmd = fontCmd;
      if (isGrande || !isPequena) {
        entregaFontCmd = Buffer.from([0x1B, 0x21, 0x18]); // Dupla Altura + Negrito para entrega fácil de ler
      }
      parts.push(entregaFontCmd);
      parts.push(Buffer.from(this.removeAcentos(compra.endereco_entrega) + '\n', 'ascii'));
    }

    // --- OBSERVAÇÕES ---
    if (!this.isVazio(compra.observacoes)) {
      parts.push(Buffer.from([0x1B, 0x21, 0x00]));
      parts.push(Buffer.from(sep + '\n', 'ascii'));
      parts.push(Buffer.from([0x1B, 0x21, 0x08]));
      parts.push(Buffer.from('OBS:\n', 'ascii'));

      let obsFontCmd = fontCmd;
      if (isGrande || !isPequena) {
        obsFontCmd = Buffer.from([0x1B, 0x21, 0x18]); // Dupla Altura + Negrito para não perder observações importantes
      }
      parts.push(obsFontCmd);
      parts.push(Buffer.from(this.removeAcentos(compra.observacoes) + '\n', 'ascii'));
    }

    // --- SEGUNDA VIA RODAPÉ ---
    if (isSegundaVia) {
      parts.push(Buffer.from([0x1B, 0x61, 0x01]));
      parts.push(Buffer.from([0x1B, 0x21, 0x08]));
      parts.push(Buffer.from('*** SEGUNDA VIA ***\n', 'ascii'));
      parts.push(Buffer.from([0x1B, 0x21, 0x00]));
    }

    parts.push(Buffer.from([0x1B, 0x21, 0x00]));
    parts.push(Buffer.from(dsep + '\n', 'ascii'));

    // Linhas extras para corte
    const extraLines = parseInt(this.config.extraLines, 10) || 3;
    parts.push(Buffer.from([0x1B, 0x64, extraLines]));

    // Comando de corte de papel (guillotine) - GS V 66 0
    parts.push(Buffer.from([0x1D, 0x56, 0x42, 0x00]));

    return Buffer.concat(parts);
  }

  // ============================================
  // BUSCA COMPLETA E OTIMIZADA DE DADOS DO PEDIDO
  // ============================================
  async _fetchOrderData(pedidoId) {
    // 1. Tenta usar o RPC otimizado (retorna tudo em 1 único round-trip)
    try {
      const { data, error } = await this.supabase
        .rpc('obter_dados_impressao_pedido', { p_pedido_id: Number(pedidoId) });

      if (!error && data && data.pedido) {
        return {
          compra: data.pedido,
          itens: data.itens || [],
          usuario: data.usuario || null
        };
      }
    } catch (e) {
      console.log('⚠️ RPC obter_dados_impressao_pedido falhou, usando fallback direto:', e.message);
    }

    // 2. Fallback resiliente via queries diretas se RPC não responder
    const pedidoResult = await this.supabase
      .from('pedidos')
      .select('*')
      .eq('id', pedidoId)
      .single();

    if (pedidoResult.error || !pedidoResult.data) {
      throw new Error('Pedido #' + pedidoId + ' não encontrado: ' + (pedidoResult.error ? pedidoResult.error.message : 'sem dados'));
    }

    const compra = pedidoResult.data;
    let usuario = null;

    if (compra.usuario_id) {
      const userResult = await this.supabase
        .from('usuario')
        .select('*')
        .eq('user_id', compra.usuario_id)
        .maybeSingle();
      if (userResult.data) usuario = userResult.data;
    }

    const itensResult = await this.supabase
      .from('itens_pedido')
      .select('id, quantidade, subtotal, preco_unitario, produto_nome, produtos(produto)')
      .eq('pedido_id', pedidoId);

    const itens = itensResult.data || [];

    if (itens.length > 0) {
      const itemIds = itens.map(item => item.id);
      const adsResult = await this.supabase
        .from('itens_pedido_adicionais')
        .select('*, opcoes_adicionais(*, produtos(*))')
        .in('item_pedido_id', itemIds);

      const adicionais = adsResult.data || [];
      itens.forEach(item => {
        item.adicionais = adicionais
          .filter(ad => ad.item_pedido_id === item.id)
          .map(ad => ({
            nome: ad.opcoes_adicionais && ad.opcoes_adicionais.produtos
              ? ad.opcoes_adicionais.produtos.produto
              : 'Adicional',
            quantidade: ad.quantidade || 1,
            preco: ad.preco_cobrado !== null ? Number(ad.preco_cobrado) : 0
          }));
      });
    }

    return { compra, itens, usuario };
  }

  // ============================================
  // PROCESSAMENTO SEGURO DE UM ITEM DA FILA
  // (Bloqueio atômico + Deduplicação em memória + Impressão precisa de cópias)
  // ============================================
  async processFilaItem(filaRecord) {
    const filaId = Number(filaRecord.id);
    const pedidoId = Number(filaRecord.pedido_id);
    const empresaId = Number(this.config.empresaId);
    const origem = filaRecord.origem || 'automatico';

    // 1. DEDUPLICAÇÃO EM MEMÓRIA
    this._cleanOldMemoryCache();

    if (this.processingFilaIds.has(filaId)) {
      console.log(`🛡️ [Deduplicação] Fila #${filaId} já está sendo processada em memória. Ignorando.`);
      return;
    }

    if (this.recentlyPrintedFilaIds.has(filaId)) {
      console.log(`🛡️ [Deduplicação] Fila #${filaId} já foi impressa recentemente. Ignorando.`);
      return;
    }

    // Marca como em processamento em memória
    this.processingFilaIds.add(filaId);

    try {
      // 2. BLOQUEIO ATÔMICO NO BANCO DE DADOS (PostgreSQL Exclusive Lock)
      // Chama a função RPC claim_item_impressao para garantir que NENHUM outro processo execute ao mesmo tempo
      let claimed = false;
      try {
        const { data: claimResult, error: claimError } = await this.supabase
          .rpc('claim_item_impressao', { p_fila_id: filaId, p_empresa_id: empresaId });

        if (claimError) {
          console.warn('⚠️ Erro ao executar claim_item_impressao RPC:', claimError.message);
          // Fallback atômico direto via UPDATE com filtro rigoroso
          const { data: updateData, error: updateError } = await this.supabase
            .from('fila_impressao')
            .update({ em_processamento: true, processando_inicio: new Date().toISOString() })
            .eq('id', filaId)
            .eq('empresa_id', empresaId)
            .eq('status', 'pendente')
            .eq('em_processamento', false)
            .select();

          claimed = !updateError && updateData && updateData.length > 0;
        } else {
          claimed = Boolean(claimResult);
        }
      } catch (err) {
        console.error('❌ Falha na tentativa de bloqueio do item:', err.message);
        claimed = false;
      }

      if (!claimed) {
        console.log(`🔒 [Lock Atômico] Fila #${filaId} (Pedido #${pedidoId}) já capturada por outro processo ou já concluída. Abortando.`);
        this.processingFilaIds.delete(filaId);
        return;
      }

      console.log(`\n🖨️ [Iniciando Impressão] Fila #${filaId} | Pedido #${pedidoId} | Origem: ${origem}`);

      // 3. BUSCA DOS DADOS DO PEDIDO
      let orderData = await this._fetchOrderData(pedidoId);

      // Se for pedido novo e os itens ainda não estiverem gravados (FlutterFlow gravando itens assincronamente),
      // aguarda inteligentemente em micro-tentativas até os itens aparecerem
      if ((!orderData.itens || orderData.itens.length === 0) && origem === 'automatico') {
        for (let attempt = 1; attempt <= 4; attempt++) {
          console.log(`⏳ Aguardando itens do Pedido #${pedidoId} (Tentativa ${attempt}/4)...`);
          await new Promise(r => setTimeout(r, 600));
          orderData = await this._fetchOrderData(pedidoId);
          if (orderData.itens && orderData.itens.length > 0) break;
        }
      }

      const { compra, itens, usuario } = orderData;

      // 4. MONTAGEM DO BUFFER ESC/POS
      const buffer = this.buildReceipt(compra, itens, usuario, false);

      // 5. IMPRESSÃO DA QUANTIDADE EXATA DE CÓPIAS CONFIGURADAS
      const configuredCopies = Math.max(1, parseInt(this.config.copies, 10) || 1);
      console.log(`📄 Imprimindo exatamente ${configuredCopies} comanda(s) configurada(s) para o Pedido #${pedidoId}...`);

      for (let i = 0; i < configuredCopies; i++) {
        console.log(`   -> Enviando cópia ${i + 1}/${configuredCopies}...`);
        await this.sendToPrinter(buffer);
        if (i < configuredCopies - 1) {
          // Pausa controlada para permitir o corte do papel e esvaziar o buffer da impressora
          await new Promise(r => setTimeout(r, 800));
        }
      }

      // 6. ATUALIZA STATUS NO BANCO PARA 'IMPRESSO' E LIBERA LOCK
      await this.supabase
        .from('fila_impressao')
        .update({
          status: 'impresso',
          em_processamento: false,
          impresso_em: new Date().toISOString()
        })
        .eq('id', filaId);

      // Registra no cache de recém-impressos
      this.recentlyPrintedFilaIds.set(filaId, Date.now());
      this.recentlyPrintedPedidoIds.set(pedidoId, Date.now());

      const label = origem === 'reimpressao' ? '🔄 REIMPRESSO COM SUCESSO' : '✅ IMPRESSO COM SUCESSO';
      console.log(`${label} — Pedido #${pedidoId} (${configuredCopies} cópia(s))`);

      if (this.config.onPrint) this.config.onPrint(pedidoId);

    } catch (error) {
      console.error(`❌ Erro durante impressão do Pedido #${pedidoId}:`, error.message);

      // Marca erro na fila e libera processamento
      try {
        await this.supabase
          .from('fila_impressao')
          .update({
            status: 'erro',
            em_processamento: false
          })
          .eq('id', filaId);
      } catch (e) { /* ignore */ }

      if (this.config.onError) this.config.onError(error.message);

    } finally {
      // Sempre remove da lista de processamento em memória
      this.processingFilaIds.delete(filaId);
    }
  }

  // Enfileira o item na fila sequencial (FIFO) para garantir execução ordenada
  enqueueFilaItem(filaRecord) {
    if (!filaRecord || !filaRecord.id) return;
    this.queue.push(() => this.processFilaItem(filaRecord));
  }

  // ============================================
  // REIMPRESSÃO MANUAL (SEGUNDA VIA)
  // ============================================
  async reprintOrder(pedidoId, isSegundaVia = true) {
    console.log('\n🖨️ [Reimpressão Manual Solicitada] Pedido #' + pedidoId);

    return this.queue.push(async () => {
      try {
        const { compra, itens, usuario } = await this._fetchOrderData(pedidoId);
        const buffer = this.buildReceipt(compra, itens, usuario, isSegundaVia);

        // Reimpressão manual emite 1 via
        await this.sendToPrinter(buffer);

        console.log('🔄 REIMPRESSÃO CONCLUÍDA — Pedido #' + pedidoId);
        if (this.config.onPrint) this.config.onPrint(pedidoId);
        return { success: true };

      } catch (error) {
        console.error('❌ Erro na reimpressão manual do Pedido #' + pedidoId + ':', error.message);
        if (this.config.onError) this.config.onError(error.message);
        throw error;
      }
    });
  }

  // ============================================
  // TESTE DE IMPRESSÃO
  // ============================================
  async printTest() {
    return this.queue.push(async () => {
      const fakeOrder = {
        id: 'TESTE',
        nome_cliente: 'Cliente Demonstracao',
        telefone_cliente: '(11) 99999-8888',
        created_at: new Date().toISOString(),
        valor_total: 99.90,
        taxa_entrega: 5.00,
        forma_pagamento: 'Cartao de Credito',
        troco_para: null,
        endereco_entrega: 'Av. Principal, 100 - Apto 22',
        observacoes: 'Sem cebola / caprichar no molho especial'
      };

      const fakeItens = [
        {
          produto_nome: 'X-Burguer Especial',
          quantidade: 2,
          preco_unitario: 29.95,
          subtotal: 59.90,
          adicionais: [
            { nome: 'Bacon Extra', quantidade: 1, preco: 4.50 },
            { nome: 'Queijo Cheddar', quantidade: 1, preco: 3.50 }
          ]
        },
        {
          produto_nome: 'Refrigerante Lata 350ml',
          quantidade: 1,
          preco_unitario: 8.00,
          subtotal: 8.00,
          adicionais: []
        }
      ];

      const buffer = this.buildReceipt(fakeOrder, fakeItens);
      const configuredCopies = Math.max(1, parseInt(this.config.copies, 10) || 1);

      console.log(`🖨️ Enviando teste (${configuredCopies} cópia(s))...`);
      for (let i = 0; i < configuredCopies; i++) {
        await this.sendToPrinter(buffer);
        if (i < configuredCopies - 1) {
          await new Promise(r => setTimeout(r, 800));
        }
      }
      console.log('✅ Teste de impressão concluído!');
    });
  }

  // ============================================
  // GERENCIAMENTO CENTRALIZADO DE STATUS
  // ============================================
  _updateStatus(newStatus) {
    if (this._currentStatus === newStatus) return;
    this._currentStatus = newStatus;
    console.log(`[Status] Mudança de status para: ${newStatus}`);
    if (this.config.onStatusChange) {
      this.config.onStatusChange(newStatus);
    }
  }

  // Testa conexão direta com o Supabase via REST
  async _verifyConnection() {
    try {
      const { error } = await this.supabase
        .from('fila_impressao')
        .select('id')
        .limit(1);
      return !error;
    } catch (e) {
      return false;
    }
  }

  // ============================================
  // INICIALIZAÇÃO E SINCRONIZAÇÃO INTELIGENTE
  // ============================================
  async start() {
    this._stopped = false;
    this._currentStatus = null;
    this._consecutivePollErrors = 0;

    const clientOptions = {
      realtime: {
        timeout: 30000,
        params: {
          eventsPerSecond: 10
        }
      }
    };

    // Cliente principal (service_role) para queries de dados — bypassa RLS
    this.supabase = createClient(this.config.supabaseUrl, this.config.supabaseKey, clientOptions);

    // Cliente Realtime (anon key) para subscrições via WebSocket
    if (this.config.supabaseAnonKey) {
      this.supabaseRealtime = createClient(this.config.supabaseUrl, this.config.supabaseAnonKey, clientOptions);
    } else {
      this.supabaseRealtime = this.supabase;
    }

    // 1. Verificação instantânea de conexão REST (fica VERDE em < 300ms)
    const isOnline = await this._verifyConnection();
    if (isOnline) {
      this.isRunning = true;
      this._updateStatus('conectado');
    } else {
      this._updateStatus('reconectando');
    }

    // 2. Limpeza preventiva na inicialização: destrava itens que possam ter ficado órfãos de sessões anteriores
    await this._resetStuckItems();

    // 3. Conecta ao Realtime filtrado por empresa
    this._connectRealtime();

    // 4. Inicia o Polling Adaptativo
    this._startAdaptivePolling();
  }

  // Reseta itens que possam ter ficado marcados como 'em_processamento' por fechamento abrupto anterior
  async _resetStuckItems() {
    if (!this.config.empresaId) return;
    try {
      await this.supabase
        .from('fila_impressao')
        .update({ em_processamento: false })
        .eq('empresa_id', this.config.empresaId)
        .eq('status', 'pendente')
        .eq('em_processamento', true);
      console.log('🧹 Limpeza de itens órfãos concluída.');
    } catch (e) {
      console.warn('⚠️ Aviso ao limpar itens órfãos:', e.message);
    }
  }

  // ============================================
  // CONEXÃO REALTIME FILTRADA E RESILIENTE
  // ============================================
  _connectRealtime() {
    if (!this.config.empresaId) return;

    if (this.channel) {
      try { this.supabaseRealtime.removeChannel(this.channel); } catch (e) { }
      this.channel = null;
    }

    const empresaIdStr = String(this.config.empresaId).trim();
    const filter = 'empresa_id=eq.' + empresaIdStr;

    console.log(`📡 Conectando Realtime para Empresa #${empresaIdStr}...`);

    this.channel = this.supabaseRealtime
      .channel('fila_impressao_empresa_' + empresaIdStr)
      // Escuta novos pedidos inseridos
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'fila_impressao', filter: filter },
        (payload) => {
          this._handleIncomingRecord(payload.new, 'realtime_insert');
        }
      )
      // Escuta atualizações de pedidos que voltaram para pendente
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'fila_impressao', filter: filter },
        (payload) => {
          if (payload.new && payload.new.status === 'pendente') {
            this._handleIncomingRecord(payload.new, 'realtime_update');
          }
        }
      )
      .subscribe((status, err) => {
        console.log(`📡 Realtime status: ${status}` + (err ? ' | Detalhes: ' + err.message : ''));
        this.realtimeStatus = status;

        if (status === 'SUBSCRIBED') {
          console.log(`✅ Conectado ao Supabase Realtime da Empresa #${empresaIdStr}!`);
          this.isRunning = true;
          this._reconnectAttempts = 0;
          this._updateStatus('conectado');

          // Ajusta polling para modo silencioso de baixa frequência (45s)
          this._adjustPollingInterval(45000);

          // Verifica pendentes iniciais com calma
          this._processPendingQueueSafe();

        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.log('ℹ️ Realtime WebSocket em contingência/espera. Polling REST ativo garantindo funcionamento contínuo.');
          this.isRunning = true;
          // IMPORTANTE: NÃO marca 'reconectando' aqui! O REST polling mantém o sistema 100% ativo e verde.
          this._adjustPollingInterval(10000);
          this._scheduleReconnect();

        } else if (status === 'CLOSED') {
          console.log('🔌 Canal Realtime fechado.');
          if (!this._stopped) {
            this._adjustPollingInterval(10000);
            this._scheduleReconnect();
          }
        }
      });
  }

  // Validador de segurança para qualquer registro recebido
  _handleIncomingRecord(record, source) {
    if (!record || !record.id || !record.pedido_id) return;

    // Defesa em profundidade: rejeita registros que não pertençam à empresa configurada
    if (String(record.empresa_id) !== String(this.config.empresaId)) {
      return;
    }

    console.log(`🚨 NOVO EVENTO (${source}) -> Fila #${record.id} | Pedido #${record.pedido_id}`);
    this.enqueueFilaItem(record);
  }

  // ============================================
  // POLLING ADAPTATIVO INTELIGENTE (SEM TRAVAMENTO)
  // ============================================
  _startAdaptivePolling() {
    this._adjustPollingInterval(12000);
  }

  _adjustPollingInterval(ms) {
    if (this._pollingTimer) {
      clearInterval(this._pollingTimer);
    }
    this._pollingTimer = setInterval(() => {
      if (!this._stopped) {
        this._processPendingQueueSafe();
      }
    }, ms);
  }

  // Processamento seguro da fila com trava de reentrância
  async _processPendingQueueSafe() {
    if (this._isPolling || this._stopped || !this.config.empresaId) return;
    this._isPolling = true;

    try {
      const { data: pendentes, error } = await this.supabase
        .from('fila_impressao')
        .select('id, pedido_id, empresa_id, status, origem, tentativas')
        .eq('empresa_id', this.config.empresaId)
        .eq('status', 'pendente')
        .eq('em_processamento', false)
        .order('id', { ascending: true })
        .limit(5);

      if (error) {
        console.warn('⚠️ Polling: Erro na leitura de pendentes:', error.message);
        if (this.realtimeStatus !== 'SUBSCRIBED') {
          this._consecutivePollErrors = (this._consecutivePollErrors || 0) + 1;
          if (this._consecutivePollErrors >= 3) {
            this._updateStatus('reconectando');
          }
        }
        return;
      }

      // Sucesso total no banco de dados! Garante que o status fique verde
      this._consecutivePollErrors = 0;
      this.isRunning = true;
      this._updateStatus('conectado');

      if (pendentes && pendentes.length > 0) {
        console.log(`📋 Polling encontrou ${pendentes.length} pedido(s) pendente(s). Enfileirando...`);
        for (const item of pendentes) {
          this.enqueueFilaItem(item);
        }
      }
    } catch (e) {
      console.warn('⚠️ Polling: Falha de conexão transitória:', e.message);
      if (this.realtimeStatus !== 'SUBSCRIBED') {
        this._consecutivePollErrors = (this._consecutivePollErrors || 0) + 1;
        if (this._consecutivePollErrors >= 3) {
          this._updateStatus('reconectando');
        }
      }
    } finally {
      this._isPolling = false;
    }
  }

  // Reconexão suave com backoff exponencial
  _scheduleReconnect() {
    if (this._stopped || this._reconnectTimer) return;

    this._reconnectAttempts = (this._reconnectAttempts || 0) + 1;
    const delay = Math.min(5000 * Math.pow(1.5, this._reconnectAttempts - 1), 60000);

    console.log(`🔄 Agendando tentativa Realtime em ${(delay / 1000).toFixed(0)}s (tentativa #${this._reconnectAttempts})...`);

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (!this._stopped) {
        this._connectRealtime();
      }
    }, delay);
  }

  // ============================================
  // ENCERRAMENTO SEGURO DO SERVIÇO
  // ============================================
  stop() {
    this._stopped = true;

    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    if (this._pollingTimer) {
      clearInterval(this._pollingTimer);
      this._pollingTimer = null;
    }

    if (this.channel) {
      try { this.supabaseRealtime.removeChannel(this.channel); } catch (e) { }
      this.channel = null;
    }

    this.isRunning = false;
    if (this.config.onStatusChange) this.config.onStatusChange('desconectado');
    console.log('🛑 PrinterService encerrado com sucesso.');
  }
}

module.exports = PrinterService;
