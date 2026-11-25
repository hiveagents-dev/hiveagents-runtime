import type { Classification, DocumentRecord } from './validation.js';

/** Deliberately small English-keyword baseline for comparing the app pipeline. */
export function baselineClassification(document: DocumentRecord): Classification {
  const category = /\bvpn\b/i.test(document.text) ? 'network' : /\bbackup\b/i.test(document.text) ? 'backups' : 'other';
  return { category, summary: document.text.slice(0, 180) };
}

/** Example bilingual domain policy; it never receives the expected labels or anchors. */
export function candidateClassification(document: DocumentRecord): Classification {
  const text = document.text;
  const business = /payroll|reunión|furniture|cafetería|invoice|onboarding|folleto|contract signature|holiday schedule/i.test(text);
  const recovery = /restor|restaur|backup|snapshot|rsync|archiv[eo]|respaldo|\btape\b|\bRPO\b|checksum|recovery|copia de seguridad/i.test(text);
  const network = /\bVPN\b|\bDNS\b|\bDHCP\b|firewall|\bWAN\b|access point|Wi-Fi|\bBGP\b|\bVLAN\b|proxy|switch|uplink/i.test(text);
  return { category: business ? 'other' : recovery ? 'backups' : network ? 'network' : 'other', summary: text.slice(0, 180) };
}
