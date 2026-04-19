import { createClient } from '@supabase/supabase-js'

const insforge = createClient('https://8bxmrdgz.us-west.insforge.app', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3OC0xMjM0LTU2NzgtOTBhYi1jZGVmMTIzNDU2NzgiLCJlbWFpbCI6ImFub25AaW5zZm9yZ2UuY29tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjY2MDR9.FMHpZN0AXrmidMv-mcxKcV0fjiJ9pUFFB4vn2eVzUTM')

async function run() {
  const { data: messages, error: e1 } = await insforge.from('messages').select('*').order('created_at', { ascending: false }).limit(5)
  console.log('Messages:', messages, e1)
  
  const { data: leads, error: e2 } = await insforge.from('leads').select('*').order('last_activity', { ascending: false }).limit(5)
  console.log('Leads:', leads, e2)
}
run()
