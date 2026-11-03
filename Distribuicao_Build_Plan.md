# Plano de Distribuição - ProIA Delivery Print

Este documento mapeia o processo de empacotamento do agente de impressão para que ele possa ser facilmente instalado nos computadores dos donos de loja.

## 🎯 Objetivo
Empacotar o projeto Electron em instaladores robustos:
1. **Windows**: `.exe` instalador via NSIS (padrão)
2. **macOS**: `.dmg` empacotador de disco

## 🛠️ Checklist de Preparação (Realizado)
- [x] Nome e Produto definidos (`ProIA Delivery Print`).
- [x] Correções nas regras de quantidade dos itens do pedido (Smart correction).
- [x] Prevenção de loop no sistema de timeout e reconexão (Supabase JS realtime).
- [x] Configuração da UI pronta (telas do Electron e persistência local da Chave e ID do lojista via `electron-store`).
- [x] Ícones de sistema devidamente compilados (`.icns` para Mac e `.png` base para Windows).

## 📦 Passos de Compilação
1. **Disparo do comando `npm run build:all`**
   Isso rodará o `electron-builder` internamente chamando `--win --mac`.
   - *Nota de Plataforma:* Rodar o build de Windows no Mac é possível nativamente pelo `electron-builder` pois ele baixa um utilitário temporário via cross-compilation (processo NSIS) para encapsular o executável de Windows.

## 🚀 Como Funcionará no Computador do Cliente (Loja)
- O cliente baixa e executa o **`.exe` ou `.dmg`**.
- O instalador colocará o app no Program Files / Aplicativos.
- O App vai se minimzar para a "setinha para cima" (bandeja do Windows) ou no canto superior da tela no Mac.
- **Auto Launch:** Se a opção for marcada na tela, o Electron usa o pacote `auto-launch` injetando uma chave de registro no Windows ou gerando um *LaunchAgent* no macOS, assim a impressora revive sozinha quando ligarem a máquina do caixa.

## 📂 Pastas de Saída (Output)
Os instaladores gerados encontram-se na pasta:
`/Users/gutemberguedourado/Documents/Apps/Print-ProIA/dist/`

Arquivos prontos para distribuição:
1. **Windows (x64)**: `ProIA Delivery Print Setup 2.0.2.exe` (Instalador NSIS com atalho no desktop e menu iniciar)
2. **macOS Apple Silicon (M1/M2/M3/M4)**: `ProIA Delivery Print-2.0.2-arm64.dmg` (Nativo ARM64)
3. **macOS Intel**: `ProIA Delivery Print-2.0.2.dmg` (Compatível com processadores Intel x64)
