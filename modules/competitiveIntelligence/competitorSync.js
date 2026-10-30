/**
 * modules/competitiveIntelligence/competitorSync.js
 *
 * Basic Information -> Competitors  ==>  admin.competitors
 *
 * The admin edits competitors in Basic Information - at onboarding OR any time later.
 * Two keys in admin.client_icp.context_json:
 *   competitors         "Lancôme, Clinique"            (old text - other features still read this)
 *   competitor_details  [{ "name": "Lancôme", "company_website": "loreal.com", "shop_website": "" }]
 * competitor_details wins when present; the old text still works for clients not re-saved yet.
 *
 * This makes admin.competitors match the list:
 *   - new name                 -> new row, discovery_status 'pending' (sources get found)
 *   - name removed             -> is_active = false (never deleted: keeps history)
 *   - name back                -> is_active = true again
 *   - company / shop website changed by the admin -> saved + 'pending' (sources found again)
 * Same brand typed differently ('Estée Lauder' / 'Estee Lauder') = same row (name_key).
 */

const { createClient } = require('@supabase/supabase-js');
const { CI_MODULE_ID } = require('./constants');
const { nameKey, clean, hostOf } = require('./webTools');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const admin = () => supabase.schema('admin');

// "https://www.loreal.com/en/" -> "loreal.com" ; "" / junk -> null
function toDomain(v) {
  const s = clean(v, 300);
  if (!s) return null;
  const host = hostOf(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  return host && host.includes('.') ? host : null;
}

/**
 * Read the admin's list from context_json.
 * @returns {Array<{name, name_key, company_domain, shop_domain}>}
 */
function parseCompetitorList(contextJson) {
  // also accept a plain string / array (old callers)
  if (typeof contextJson === 'string' || Array.isArray(contextJson)) {
    return parseCompetitorList({ competitors: contextJson });
  }
  const ctx = contextJson || {};
  let rows = [];
  if (Array.isArray(ctx.competitor_details) && ctx.competitor_details.length) {
    rows = ctx.competitor_details.map((d) => (typeof d === 'string'
      ? { name: d }
      : { name: d && d.name, company: d && d.company_website, shop: d && d.shop_website }));
  } else {
    let list = [];
    if (Array.isArray(ctx.competitors)) list = ctx.competitors;
    else if (typeof ctx.competitors === 'string') list = ctx.competitors.split(/[\n,;]+/);
    rows = list.map((n) => ({ name: n }));
  }
  const out = new Map();
  for (const r of rows) {
    const name = clean(r.name, 120);
    const key = nameKey(name);
    if (!name || !key || out.has(key)) continue;
    out.set(key, { name, name_key: key, company_domain: toDomain(r.company), shop_domain: toDomain(r.shop) });
  }
  return [...out.values()];
}

/**
 * @returns {Promise<{added: string[], reactivated: string[], deactivated: string[], changed: string[], active: object[]}>}
 */
async function syncCompetitorsForClient(clientId) {
  const { data: icp, error: icpErr } = await admin()
    .from('client_icp')
    .select('context_json')
    .eq('client_id', clientId)
    .maybeSingle();
  if (icpErr) throw new Error(`client_icp read failed: ${icpErr.message}`);

  const wanted = parseCompetitorList(icp && icp.context_json);
  const wantedKeys = new Set(wanted.map((w) => w.name_key));

  const { data: existing, error: exErr } = await admin()
    .from('competitors')
    .select('id, name, name_key, is_active, company_domain, shop_domain, discovery_status, discovery_note')
    .eq('client_id', clientId);
  if (exErr) throw new Error(`competitors read failed: ${exErr.message}`);

  const byKey = new Map((existing || []).map((c) => [c.name_key, c]));
  const added = [];
  const reactivated = [];
  const deactivated = [];
  const changed = [];

  for (const w of wanted) {
    const row = byKey.get(w.name_key);
    if (!row) {
      const { error } = await admin().from('competitors').insert({
        client_id: clientId,
        name: w.name,
        name_key: w.name_key,
        search_name: w.name,
        company_domain: w.company_domain,
        shop_domain: w.shop_domain,
        discovery_status: 'pending',
      });
      if (error && !/duplicate key/i.test(error.message)) throw new Error(`insert competitor ${w.name}: ${error.message}`);
      added.push(w.name);
      continue;
    }

    const patch = {};
    if (!row.is_active) { patch.is_active = true; reactivated.push(w.name); }
    if (row.name !== w.name) patch.name = w.name;
    // only a website the ADMIN typed changes anything; an empty box keeps what discovery found
    const siteChanged = (w.company_domain && w.company_domain !== row.company_domain)
      || (w.shop_domain && w.shop_domain !== row.shop_domain);
    if (w.company_domain && w.company_domain !== row.company_domain) patch.company_domain = w.company_domain;
    if (w.shop_domain && w.shop_domain !== row.shop_domain) patch.shop_domain = w.shop_domain;
    // the admin typed the SAME website the system had guessed = the guess is now confirmed
    const confirmsGuess = !siteChanged && w.company_domain && row.discovery_status === 'needs_check'
      && /guessed/i.test(row.discovery_note || '');
    if (confirmsGuess) {
      patch.discovery_status = 'pending';
      patch.discovery_note = 'Company website confirmed by admin - finding sources again.';
      changed.push(w.name);
    }
    if (siteChanged) {
      patch.discovery_status = 'pending';   // find the sources again with the new website
      patch.discovery_note = 'Website changed by admin - finding sources again.';
      changed.push(w.name);
    }
    if (Object.keys(patch).length) {
      const { error } = await admin().from('competitors').update(patch).eq('id', row.id);
      if (error) throw new Error(`update competitor ${w.name}: ${error.message}`);
    }
  }

  // removed from Basic Information -> switch off (keep history)
  for (const row of existing || []) {
    if (row.is_active && !wantedKeys.has(row.name_key)) {
      const { error } = await admin().from('competitors').update({ is_active: false }).eq('id', row.id);
      if (error) throw new Error(`deactivate competitor ${row.name}: ${error.message}`);
      deactivated.push(row.name);
    }
  }

  const { data: active, error: actErr } = await admin()
    .from('competitors')
    .select('*')
    .eq('client_id', clientId)
    .eq('is_active', true)
    .order('name');
  if (actErr) throw new Error(`competitors re-read failed: ${actErr.message}`);

  if (added.length || reactivated.length || deactivated.length || changed.length) {
    console.log(`[CI sync] client ${clientId}: +${added.length} added, ${reactivated.length} back, ${deactivated.length} off, ${changed.length} website changed, ${(active || []).length} active`);
  }
  return { added, reactivated, deactivated, changed, active: active || [] };
}

/** Every client that has the Competitive Intelligence module switched on. */
async function listCiClients() {
  const { data, error } = await admin().from('clients').select('id, enabled_modules');
  if (error) throw new Error(`clients read failed: ${error.message}`);
  return (data || [])
    .filter((c) => {
      const m = c.enabled_modules;
      if (Array.isArray(m)) return m.includes(CI_MODULE_ID);
      if (m && typeof m === 'object') return Object.prototype.hasOwnProperty.call(m, CI_MODULE_ID) || Object.values(m).includes(CI_MODULE_ID);
      return typeof m === 'string' && m.includes(CI_MODULE_ID);
    })
    .map((c) => c.id);
}

module.exports = { syncCompetitorsForClient, parseCompetitorList, listCiClients, toDomain };