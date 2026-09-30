import { parseGmailQuery } from './query.js';
import { getTarget, capabilityCheck, defaultFolders } from './targets.js';

// ponytail: compile only the proven query subset; unsupported fields skip the
// WHOLE rule rather than removing predicates and broadening delivery.
// Property names/values remain Gmail's strings in the public model. unknown holds
// diagnostic strings. Empty known fields and false boolean switches are inactive.
const ATOM = 'http://www.w3.org/2005/Atom';
const APPS = 'http://schemas.google.com/apps/2006';
const CRITERIA = new Set(['from', 'to', 'subject', 'hasTheWord', 'doesNotHaveTheWord', 'hasAttachment', 'excludeChats', 'size', 'sizeOperator', 'sizeUnit']);
const ACTIONS = new Set(['label', 'forwardTo', 'shouldArchive', 'shouldMarkAsRead', 'shouldStar', 'shouldTrash', 'shouldNeverSpam', 'shouldAlwaysMarkAsImportant', 'shouldNeverMarkAsImportant', 'smartLabelToApply']);
const SWITCHES = new Set(['hasAttachment', 'excludeChats', 'shouldArchive', 'shouldMarkAsRead', 'shouldStar', 'shouldTrash', 'shouldNeverSpam', 'shouldAlwaysMarkAsImportant', 'shouldNeverMarkAsImportant']);
const unsafe = value => /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value);
const quote = value => '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
// Deliberately accepts only an ASCII dot-atom mailbox with a DNS-style domain.
// No display names, groups, lists, quoted local parts, wildcards, or query syntax.
const mailbox = value => /^[a-z0-9!#$%&'+/=?^_`~-]+(?:\.[a-z0-9!#$%&'+/=?^_`~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(value);

export function parseFilters(xmlDocument) {
  if (!xmlDocument?.documentElement || typeof xmlDocument.getElementsByTagNameNS !== 'function') {
    throw new TypeError('parseFilters expects an XML Document from DOMParser.');
  }
  const root = xmlDocument.documentElement;
  if (xmlDocument.doctype || xmlDocument.getElementsByTagNameNS('*', 'parsererror').length || root.namespaceURI !== ATOM || root.localName !== 'feed') {
    throw new Error('Invalid Gmail filter XML: expected an Atom feed without a DOCTYPE.');
  }
  return Array.from(root.children).filter(node => node.namespaceURI === ATOM && node.localName === 'entry').map((entry, index) => {
    const filter = { id: `rule-${index + 1}`, criteria: {}, actions: {}, unknown: [] };
    const seen = new Set();
    for (const node of entry.children) {
      if (node.namespaceURI === ATOM && node.localName === 'id') filter.id = node.textContent || filter.id;
      // Atom title/category/content/updated and feed metadata describe the export,
      // not rule predicates. Only apps:property elements encode Gmail rules.
      if (node.localName !== 'property') continue;
      const name = node.getAttribute('name');
      const value = node.getAttribute('value');
      if (node.namespaceURI !== APPS || !name || value === null || seen.has(name)) {
        filter.unknown.push(`Invalid or duplicate property: ${name || '(unnamed)'}`);
        continue;
      }
      seen.add(name);
      if (CRITERIA.has(name)) filter.criteria[name] = value;
      else if (ACTIONS.has(name)) filter.actions[name] = value;
      else filter.unknown.push(`Unsupported XML property: ${name}`);
    }
    return filter;
  });
}

/**
 * Portable Sieve subset, not a complete Gmail emulator. Target folders must exist.
 * Labels use fileinto; keep preserves Inbox when not archiving. Archive and Trash
 * are conventional folders, not provider-specific special-use lookups. Trash is
 * never discard. No stop: every matching rule can run (and produce extra copies).
 * Subject accepts plain text only; substring vs Gmail token matching is flagged.
 * Approximate rules are fully commented out unless includeApproximate is true.
 * Multiple valid rules involving delivery are all approximate: explicit keep and
 * per-delivery flags cannot reproduce Gmail's accumulated actions reliably.
 * Generic/Fastmail/Proton use identical standard syntax; Outlook/Yahoo skip.
 */
export function convertFilters(filters, { target = 'generic', folderMap = {}, archiveFolder, trashFolder, includeApproximate = false } = {}) {
  if (!Array.isArray(filters)) throw new TypeError('filters must be an array.');
  const provider = getTarget(target);
  const defaults = defaultFolders(provider);
  if (!folderMap || typeof folderMap !== 'object' || Array.isArray(folderMap)) throw new TypeError('folderMap must be a label-to-folder object.');
  // Explicit system-folder options take precedence over legacy folderMap keys.
  const destinations = new Map(Object.entries(folderMap));
  for (const filter of filters) if (typeof filter?.actions?.label === 'string' && filter.actions.label) {
    const label = filter.actions.label;
    if (!destinations.has(label)) destinations.set(label, label);
  }
  const archive = archiveFolder !== undefined ? archiveFolder : Object.hasOwn(folderMap, 'Archive') ? folderMap.Archive : defaults.archiveFolder;
  const trash = trashFolder !== undefined ? trashFolder : Object.hasOwn(folderMap, 'Trash') ? folderMap.Trash : defaults.trashFolder;
  const folderKey = value => typeof value === 'string' ? value.normalize('NFC').trim().toLowerCase() : null;
  const collides = (name, value, system = false) => {
    const key = folderKey(value);
    if (key === 'inbox') return true;
    if (system && folderKey(archive) === folderKey(trash)) return true;
    if (!system && (key === folderKey(archive) || key === folderKey(trash))) return true;
    return [...destinations].some(([other, destination]) => other !== name && key === folderKey(destination));
  };
  const results = [], gaps = [], blocks = [], requirements = new Set();
  for (const [index, filter] of filters.entries()) {
    const id = typeof filter?.id === 'string' ? filter.id : `rule-${index + 1}`;
    const issues = [], warnings = [], tests = [], commands = [], needed = new Set();
    const criteria = filter?.criteria, actions = filter?.actions;
    if (provider.kind === 'recipe') issues.push('This target requires manual rules; no Sieve can be emitted.');
    if (target === 'unknown') warnings.push('Unknown destination uses the generic capability baseline only; confirm server support before enabling.');
    if (!criteria || !actions || typeof criteria !== 'object' || typeof actions !== 'object' || Array.isArray(criteria) || Array.isArray(actions)) issues.push('Invalid filter model.');
    if (unsafe(id)) issues.push('Unsafe control character in rule ID.');
    if (filter?.unknown?.length) issues.push(...Array.from(filter.unknown, value => String(value)));
    const active = {};
    for (const [fields, allowed] of [[criteria || {}, CRITERIA], [actions || {}, ACTIONS]]) {
      for (const [name, raw] of Object.entries(fields)) {
        if (!allowed.has(name)) { issues.push(`Unsupported field: ${name}`); continue; }
        if (typeof raw !== 'string' && typeof raw !== 'boolean' && typeof raw !== 'number') { issues.push(`Invalid value for ${name}.`); continue; }
        const value = String(raw);
        if (unsafe(value)) { issues.push(`Unsafe control character in ${name}.`); continue; }
        if (value === '') continue;
        if (SWITCHES.has(name)) {
          if (value === 'false') continue;
          if (value !== 'true') { issues.push(`Invalid boolean for ${name}.`); continue; }
        }
        active[name] = value;
      }
    }
    for (const name of ['hasAttachment', 'excludeChats', 'shouldNeverSpam', 'shouldAlwaysMarkAsImportant', 'shouldNeverMarkAsImportant', 'smartLabelToApply']) {
      if (active[name]) issues.push(`Unsupported ${name}; the entire rule was skipped.`);
    }
    for (const name of ['from', 'to']) {
      if (!active[name]) continue;
      if (!mailbox(active[name])) issues.push(`${name} must contain one exact email address, not Gmail search syntax.`);
      else tests.push(`address :is ${quote(name)} ${quote(active[name])}`);
    }
    if (active.subject) {
      if (!/^[\p{L}\p{N}][\p{L}\p{N} .,_'!?@&%-]*$/u.test(active.subject) || /\b(?:OR|AND|NOT)\b/.test(active.subject)) issues.push('Subject must be plain literal text without search operators.');
      else {
        tests.push(`header :contains "subject" ${quote(active.subject)}`);
        warnings.push('Subject uses a literal substring test; Gmail word matching may differ. Review before enabling.');
      }
    }
    const allof = parts => parts.length === 1 ? parts[0] : `allof (${parts.join(', ')})`;
    for (const name of ['hasTheWord', 'doesNotHaveTheWord']) {
      if (!active[name]) continue;
      const parsed = parseGmailQuery(active[name]);
      issues.push(...parsed.unsupported.map(issue => `${name}: ${issue}`));
      const compile = test => {
        if (['from', 'to', 'cc'].includes(test.field) && test.op === 'is' && typeof test.value === 'string' && mailbox(test.value)) return `address :is ${quote(test.field)} ${quote(test.value)}`;
        if (test.field === 'size' && ['over', 'under'].includes(test.op) && Number.isSafeInteger(test.value) && test.value >= 0 && test.value <= 4294967295) return `size :${test.op} ${test.value}`;
        if (test.field === 'subject' && test.op === 'contains' && typeof test.value === 'string' && test.value.trim() && !unsafe(test.value)) {
          warnings.push('Query subject uses a literal substring test; Gmail word matching may differ. Review before enabling.');
          return `header :contains "subject" ${quote(test.value)}`;
        }
        issues.push(`Unsupported query condition ${test.raw}; the entire rule was skipped.`);
        return null;
      };
      if (!Array.isArray(parsed.tests) || !Array.isArray(parsed.negated) || !Array.isArray(parsed.unsupported)) {
        issues.push(`${name}: query parser returned an invalid result; the entire rule was skipped.`);
        continue;
      }
      const positive = parsed.tests.map(compile);
      const negative = parsed.negated.map(test => { const expression = compile(test); return expression === null ? null : `not ${expression}`; });
      const parts = [...positive, ...negative];
      if (!parsed.unsupported.length && parts.length && !parts.includes(null)) tests.push(`${name === 'doesNotHaveTheWord' ? 'not ' : ''}${allof(parts)}`);
    }
    // Gmail exports sizeOperator/sizeUnit even without size. These two fields
    // alone are inactive UI metadata, the only ignored criterion metadata.
    if (active.size !== undefined) {
      const units = { s_sb: 1, s_skb: 1024, s_smb: 1048576 };
      const operators = { s_sl: ':over', s_ss: ':under' };
      const amount = Number(active.size) * units[active.sizeUnit];
      if (!/^\d+$/.test(active.size) || !Object.hasOwn(units, active.sizeUnit) || !Object.hasOwn(operators, active.sizeOperator) || !Number.isSafeInteger(amount) || amount < 0 || amount > 4294967295) issues.push('Size needs an integer, known Gmail unit/operator, and a 32-bit byte count.');
      else tests.push(`size ${operators[active.sizeOperator]} ${amount}`);
    }
    if (!tests.length) issues.push('No supported condition; unconditional rules are not emitted.');
    if (active.shouldTrash && (active.label || active.shouldArchive)) issues.push('Trash combined with label/archive has ambiguous delivery semantics.');
    if (active.shouldStar || active.shouldMarkAsRead) warnings.push('Per-rule flags may not preserve Gmail accumulated flag behavior across matching rules.');
    const folder = (name, systemValue) => {
      needed.add('fileinto');
      const system = systemValue !== undefined;
      const mapped = system ? systemValue : destinations.get(name);
      if (typeof mapped !== 'string' || !mapped.trim() || unsafe(mapped)) { issues.push(`Invalid or unsafe destination folder for ${name}.`); return; }
      if (collides(name, mapped, system)) { issues.push(`Destination folder collision for ${name}; the entire rule was skipped.`); return; }
      commands.push(`fileinto ${quote(mapped)};`);
    };
    if (active.shouldMarkAsRead) { commands.push('addflag "\\\\Seen";'); needed.add('imap4flags'); }
    if (active.shouldStar) { commands.push('addflag "\\\\Flagged";'); needed.add('imap4flags'); }
    if (active.shouldTrash) {
      folder('Trash', trash);
      warnings.push('Trash is mapped to a Trash folder, not permanent deletion; confirm the destination folder.');
    } else if (active.label) folder(active.label);
    else if (active.shouldArchive) folder('Archive', archive);
    if (active.label && !active.shouldArchive) warnings.push('Gmail labels are not independent message copies; fileinto plus keep approximates labeling and may create separate copies.');
    if (active.shouldArchive) warnings.push('Archive removes Inbox delivery by filing into the mapped label or Archive folder; verify provider folder semantics.');
    if (active.forwardTo) {
      if (!mailbox(active.forwardTo)) issues.push('Forwarding requires one exact email address.');
      else commands.push(`redirect ${quote(active.forwardTo)};`);
    }
    // fileinto and redirect cancel implicit keep. A label without archive must
    // still retain Inbox, even when forwarding. Forward-only also keeps locally.
    if ((active.label && !active.shouldArchive && !active.shouldTrash) || (active.forwardTo && !needed.has('fileinto'))) commands.push('keep;');
    if (!commands.length) issues.push('No supported action.');
    issues.push(...capabilityCheck(provider, { extensions: [...needed], actions: commands.map(command => command.split(' ')[0].replace(';', '')), ruleCount: 0 }).unsupported);
    const status = issues.length ? 'skipped' : warnings.length ? 'approximate' : 'converted';
    const description = `${Object.entries(criteria || {}).map(([key, value]) => `${key}=${String(value)}`).join(', ') || '(no conditions)'} → ${Object.entries(actions || {}).map(([key, value]) => `${key}=${String(value)}`).join(', ') || '(no actions)'}`;
    const allIssues = [...issues, ...warnings];
    results.push({ id, status, description, issues: allIssues, requiredExtensions: [...needed].sort(), generated: '' });
    blocks.push({ needed, delivery: !!(active.label || active.shouldArchive || active.shouldTrash || active.forwardTo), body: `if ${tests.length === 1 ? tests[0] : `allof (${tests.join(', ')})`} {\n${commands.map(command => `  ${command}`).join('\n')}\n}` });
  }
  // These blocks form one script; target active-rule limits count scripts, not blocks.
  const limitIssues = capabilityCheck(provider, { ruleCount: 1 }).unsupported;
  if (limitIssues.length) for (const result of results) {
    if (result.status === 'skipped') continue;
    result.status = 'skipped';
    result.issues.push(...limitIssues);
  }
  const valid = results.flatMap((result, index) => result.status === 'skipped' ? [] : [index]);
  // ponytail: do not attempt overlap proofs or action aggregation; a later rule
  // can match the same message even when its literal predicates are different.
  if (valid.length > 1 && valid.some(index => blocks[index].delivery)) {
    for (const index of valid) {
      results[index].status = 'approximate';
      results[index].issues.push('Multiple rules may match: Gmail accumulated delivery/flag semantics differ from Sieve keep/fileinto and per-delivery flags. Manual review required.');
    }
  }
  const rendered = results.map((result, index) => {
    gaps.push(...result.issues.map(issue => `${result.id}: ${issue}`));
    // Never interpolate user data into comments: an ID can contain Sieve tokens.
    if (result.status === 'skipped') return result.generated = `# Rule ${index + 1} skipped; see conversion report.`;
    const disabled = result.status === 'approximate' && includeApproximate !== true;
    if (disabled) {
      const issue = 'Approximate rule disabled by default; review before explicitly enabling.';
      result.issues.push(issue);
      gaps.push(`${result.id}: ${issue}`);
    } else for (const extension of blocks[index].needed) requirements.add(extension);
    const neededLine = result.requiredExtensions.length ? `# Needed at script top before enabling: require [${result.requiredExtensions.map(quote).join(', ')}];\n` : '';
    return result.generated = `# Rule ${index + 1}${result.status === 'approximate' ? ` (approximate; ${disabled ? 'DISABLED' : 'explicitly enabled'}; review report)` : ''}\n` + neededLine + (disabled ? blocks[index].body.split('\n').map(line => '# ' + line).join('\n') : blocks[index].body);
  });
  const header = '# Gmail filter conversion. Review the report and create destination folders before enabling.\n';
  const requires = requirements.size ? `require [${[...requirements].sort().map(quote).join(', ')}];\n\n` : '';
  return { sieve: header + requires + rendered.join('\n\n') + '\n', results, gaps };
}
