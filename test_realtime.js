const { createClient } = require('@supabase/supabase-js');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const supabaseUrl = process.env.SUPABASE_URL || 'https://askqkwvpjhotytmxcfqx.supabase.co';
const supabaseKey = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFza3Frd3ZwamhvdHl0bXhjZnF4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI2NDcxNTMsImV4cCI6MjA4ODIyMzE1M30.GDFVXEYt0aZSMgZ6xhyrl9oA-DeKqP1i4JkyukWQ06A';

const supabase = createClient(supabaseUrl, supabaseKey);

console.log('Tentando conectar ao Realtime...');
const channel = supabase
  .channel('test_realtime')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'fila_impressao' }, (payload) => {
    console.log('Change received!', payload);
  })
  .subscribe((status, err) => {
    console.log('Status do Realtime:', status);
    if (err) console.error('Erro:', err);
    if (status === 'SUBSCRIBED') {
      console.log('Sucesso! Realtime está funcionando.');
      process.exit(0);
    }
    if (status === 'CHANNEL_ERROR') {
      console.error('Falha ao conectar. Realtime pode estar desativado para esta tabela.');
      process.exit(1);
    }
  });

// Timeout de 15s
setTimeout(() => {
  console.log('Timeout aguardando conexão.');
  process.exit(1);
}, 15000);
