import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';

// env vars (set in GitHub Actions)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

// testing controls
const FORCE_SEND = process.env.FORCE_SEND === '1';              // bypass 7:00-7:05 window if '1'
const TARGET_EMAIL = process.env.TARGET_EMAIL || '';            // if set, only send to this email

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.error('Missing Supabase envs. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE');
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
  } catch (e) {
    return null;
  }
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

  // create a job_runs row
  const { data: jrCreate, error: jrErr } = await supabase
    .from('job_runs')
    .insert([{ job_name: 'daily_digest_sms', started_at: new Date().toISOString() }])
    .select('*')
    .single();

  if (jrErr) console.warn('Could not create job_runs row:', jrErr.message);

  // fetch users who consented
  const { data: users, error } = await supabase
    .from('users') // this is the view we created
    .select('id, email, phone, timezone, sms_consent')
    .eq('sms_consent', true);

  if (error) {
    console.error('Error fetching users:', error);
    process.exit(1);
  }

  // if TARGET_EMAIL is set, filter to that one user
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
        console.log(`Skipping ${u.email} - no timezone`);
        continue;
      }

      const lm = getLocalHourMinute(u.timezone);
      if (!lm) {
        skipped++;
        console.log(`Skipping ${u.email} - couldn't compute local time`);
        continue;
      }

      // unless FORCE_SEND, only send between 19:00 and 19:05 local time
      const inWindow = (lm.hour === 19 && lm.minute < 10); // 19:00–19:09 local
if (!FORCE_SEND && !inWindow) {
  skipped++;
  continue;
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

  // update job_runs with results
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
