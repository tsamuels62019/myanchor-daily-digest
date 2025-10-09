import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';

// env vars (set in GitHub Actions)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

// testing controls
const FORCE_SEND = process.env.FORCE_SEND === '1';   // bypass time window if '1'
const TARGET_EMAIL = process.env.TARGET_EMAIL || ''; // optional single user

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.error('Missing Supabase envs.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

function formatToE164(phone) {
  if (!phone) return null;
  const cleaned = phone.replace(/[^\d]/g, '');
  if (cleaned.length === 10) return `+1${cleaned}`;
  if (cleaned.length === 11 && cleaned.startsWith('1')) return `+${cleaned}`;
  if (phone.startsWith('+')) return phone;
  return `+${cleaned}`;
}

function getLocalHourMinute(timezone) {
  try {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit'
    }).formatToParts(now);
    const hour = parseInt(parts.find(p => p.type === 'hour').value, 10);
    const minute = parseInt(parts.find(p => p.type === 'minute').value, 10);
    return { hour, minute };
  } catch {
    return null;
  }
}

// Returns ok=true if current local time is between start and end (inclusive)
function inLocalWindow(timezone, startHour, startMinute, endHour, endMinute) {
  const lm = getLocalHourMinute(timezone);
  if (!lm) return { ok: false, reason: 'no_local_time' };

  const currentMins = lm.hour * 60 + lm.minute;
  const startMins = startHour * 60 + startMinute;
  const endMins = endHour * 60 + endMinute;

  const ok = currentMins >= startMins && currentMins <= endMins;
  return { ok, time: `${lm.hour}:${String(lm.minute).padStart(2, '0')}` };
}

async function sendTwilioSms(to, body) {
  const formatted = formatToE164(to);
  if (!formatted) throw new Error('invalid phone');

  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
  const form = new URLSearchParams({
    To: formatted,
    From: TWILIO_PHONE_NUMBER,
    Body: body
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: form.toString()
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Twilio error ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function main() {
  console.log('Starting daily digest run', new Date().toISOString(), { FORCE_SEND, TARGET_EMAIL });

  const { data: jrCreate } = await supabase
    .from('job_runs')
    .insert([{ job_name: 'daily_digest_sms', started_at: new Date().toISOString() }])
    .select('*')
    .single();

  const { data: users, error } = await supabase
    .from('users')
    .select('id, email, phone, timezone, sms_consent')
    .eq('sms_consent', true);

  if (error) {
    console.error('Error fetching users:', error);
    process.exit(1);
  }

  const targetList = TARGET_EMAIL
    ? users.filter(u => u.email && u.email.toLowerCase() === TARGET_EMAIL.toLowerCase())
    : users;

  let attempted = 0, sent = 0, skipped = 0;
  const errors = [];

  for (const u of targetList) {
    attempted++;
    try {
      if (!u.timezone) {
        skipped++;
        errors.push({ user: u.email, reason: 'no_timezone' });
        continue;
      }

      // Only send between 9:00 PM and 9:10 PM local time unless FORCE_SEND is set
      if (!FORCE_SEND) {
        const win = inLocalWindow(u.timezone, 21, 0, 21, 10); // 9:00–9:10 PM local
        if (!win.ok) {
          skipped++;
          errors.push({ user: u.email, reason: 'outside_window', time: win.time || 'n/a' });
          continue;
        }
      }

      const today = new Intl.DateTimeFormat('en-CA', { timeZone: u.timezone }).format(new Date());
      const { data: existing } = await supabase
        .from('daily_digest_sms')
        .select('id')
        .eq('user_id', u.id)
        .eq('digest_date', today)
        .limit(1);

      if (existing && existing.length > 0) {
        skipped++;
        console.log(`Already sent today to ${u.email}`);
        continue;
      }

      const tw = await sendTwilioSms(u.phone, 'Your daily digest for tomorrow has been updated - open MyAnchor to prepare.');
      await supabase
        .from('daily_digest_sms')
        .insert([{ user_id: u.id, digest_date: today, sent_at: new Date().toISOString() }]);

      sent++;
      console.log(`Sent to ${u.email} (${tw.sid})`);
    } catch (e) {
      console.error('Error for user', u.email, e.message);
      errors.push({ user: u.email, error: e.message });
    }
  }

  if (jrCreate && jrCreate.id) {
    await supabase
      .from('job_runs')
      .update({
        finished_at: new Date().toISOString(),
        attempted, sent, skipped,
        details: { FORCE_SEND, TARGET_EMAIL, errors }
      })
      .eq('id', jrCreate.id);
  }

  console.log({ attempted, sent, skipped, errors });
  process.exit(0);
}

main();
