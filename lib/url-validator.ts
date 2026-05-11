// =============================================================================
// URL Validator — SSRF Protection
// Blocks callback URLs targeting private/internal/cloud-metadata addresses.
// =============================================================================

import { URL } from 'node:url';
import { isIP } from 'node:net';

interface ValidationResult {
  safe: boolean;
  reason?: string;
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

const BLOCKED_HOSTNAMES = new Set(['localhost', '0.0.0.0']);

/**
 * Check whether an IPv4 address falls within blocked private/internal ranges.
 */
function isBlockedIPv4(ip: string): string | null {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p))) return null;

  const [a, b] = parts;

  // Loopback: 127.0.0.0/8
  if (a === 127) return 'Loopback address blocked';

  // Private: 10.0.0.0/8
  if (a === 10) return 'Private IP address blocked';

  // Private: 172.16.0.0/12 (172.16.0.0 – 172.31.255.255)
  if (a === 172 && b >= 16 && b <= 31) return 'Private IP address blocked';

  // Private: 192.168.0.0/16
  if (a === 192 && b === 168) return 'Private IP address blocked';

  // Link-local: 169.254.0.0/16 (includes cloud metadata 169.254.169.254)
  if (a === 169 && b === 254) return 'Link-local/cloud metadata address blocked';

  // Unspecified: 0.0.0.0
  if (a === 0 && b === 0 && parts[2] === 0 && parts[3] === 0) return 'Unspecified address blocked';

  return null;
}

/**
 * Check whether an IPv6 address is blocked (loopback or link-local).
 */
function isBlockedIPv6(ip: string): string | null {
  const normalized = ip.toLowerCase();

  // Loopback ::1
  if (normalized === '::1' || normalized === '0000:0000:0000:0000:0000:0000:0000:0001') {
    return 'IPv6 loopback address blocked';
  }

  // Link-local fe80::/10
  if (normalized.startsWith('fe80:') || normalized.startsWith('fe80')) {
    return 'IPv6 link-local address blocked';
  }

  return null;
}

/**
 * Validates whether a callback URL is safe to make an HTTP request to.
 * Blocks private IPs, loopback, link-local, cloud metadata, and non-HTTP(S) schemes.
 */
export function isCallbackUrlSafe(url: string): ValidationResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { safe: false, reason: 'Invalid URL' };
  }

  // Block non-HTTP(S) schemes
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return { safe: false, reason: `Protocol "${parsed.protocol}" is not allowed — only HTTP(S)` };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block known dangerous hostnames
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { safe: false, reason: `Hostname "${hostname}" is blocked` };
  }

  // Strip IPv6 brackets if present (URL parser already does this for .hostname)
  const bare = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;

  // Check if hostname is an IP literal
  if (isIP(bare) === 4) {
    const reason = isBlockedIPv4(bare);
    if (reason) return { safe: false, reason };
  } else if (isIP(bare) === 6) {
    const reason = isBlockedIPv6(bare);
    if (reason) return { safe: false, reason };
  }

  // Hostname is a domain name — not an IP. Allow it.
  // DNS rebinding attacks would require async resolution; this is a synchronous
  // first-pass filter. The runtime callback also has a 10s timeout.
  return { safe: true };
}
