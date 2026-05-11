import { describe, it, expect } from 'vitest';
import { isCallbackUrlSafe } from '../lib/url-validator';

describe('isCallbackUrlSafe', () => {
  // ---- Blocked URLs ----

  describe('blocks private/internal addresses', () => {
    it('blocks loopback 127.0.0.1', () => {
      const result = isCallbackUrlSafe('http://127.0.0.1/callback');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('Loopback');
    });

    it('blocks 10.x private range', () => {
      const result = isCallbackUrlSafe('http://10.0.0.1/callback');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('Private IP');
    });

    it('blocks 172.16.x private range', () => {
      const result = isCallbackUrlSafe('http://172.16.0.1/callback');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('Private IP');
    });

    it('blocks 192.168.x private range', () => {
      const result = isCallbackUrlSafe('http://192.168.1.1/callback');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('Private IP');
    });

    it('blocks cloud metadata 169.254.169.254', () => {
      const result = isCallbackUrlSafe('http://169.254.169.254/latest/meta-data/');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('Link-local');
    });

    it('blocks link-local range 169.254.x.x', () => {
      const result = isCallbackUrlSafe('http://169.254.1.1/');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('Link-local');
    });
  });

  describe('blocks dangerous hostnames', () => {
    it('blocks localhost', () => {
      const result = isCallbackUrlSafe('http://localhost:3000/callback');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('localhost');
    });

    it('blocks 0.0.0.0', () => {
      const result = isCallbackUrlSafe('http://0.0.0.0:8080/callback');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('0.0.0.0');
    });
  });

  describe('blocks non-HTTP(S) schemes', () => {
    it('blocks ftp://', () => {
      const result = isCallbackUrlSafe('ftp://example.com/upload');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('Protocol');
    });

    it('blocks file://', () => {
      const result = isCallbackUrlSafe('file:///etc/passwd');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('Protocol');
    });
  });

  describe('blocks IPv6 dangerous addresses', () => {
    it('blocks ::1 loopback', () => {
      const result = isCallbackUrlSafe('http://[::1]/callback');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('IPv6 loopback');
    });
  });

  describe('rejects invalid URLs', () => {
    it('rejects garbage input', () => {
      const result = isCallbackUrlSafe('not-a-url');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('Invalid URL');
    });
  });

  // ---- Allowed URLs ----

  describe('allows valid external URLs', () => {
    it('allows https://example.com', () => {
      const result = isCallbackUrlSafe('https://example.com/webhook');
      expect(result.safe).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('allows https://hooks.slack.com', () => {
      const result = isCallbackUrlSafe('https://hooks.slack.com/services/T00/B00/xxx');
      expect(result.safe).toBe(true);
    });

    it('allows http://api.external.com', () => {
      const result = isCallbackUrlSafe('http://api.external.com/callback');
      expect(result.safe).toBe(true);
    });

    it('allows public IP addresses', () => {
      const result = isCallbackUrlSafe('https://8.8.8.8/callback');
      expect(result.safe).toBe(true);
    });
  });

  // ---- Edge cases ----

  describe('edge cases', () => {
    it('blocks 127.0.0.2 (still loopback range)', () => {
      const result = isCallbackUrlSafe('http://127.0.0.2/');
      expect(result.safe).toBe(false);
    });

    it('blocks 172.31.255.255 (end of 172.16/12 range)', () => {
      const result = isCallbackUrlSafe('http://172.31.255.255/');
      expect(result.safe).toBe(false);
    });

    it('allows 172.32.0.1 (outside private range)', () => {
      const result = isCallbackUrlSafe('http://172.32.0.1/');
      expect(result.safe).toBe(true);
    });

    it('allows 192.167.1.1 (outside 192.168/16 range)', () => {
      const result = isCallbackUrlSafe('http://192.167.1.1/');
      expect(result.safe).toBe(true);
    });
  });
});
