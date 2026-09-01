import "@testing-library/jest-dom";

// Lucia was replaced by the session handling in src/lib/auth.ts and is no
// longer a dependency. Mocking it made every suite fail to resolve before it
// could run a single test.

// Mock environment variables
process.env.S3_BUCKET_NAME = "test-bucket";
process.env.CLOUDFLARE_ZONE_ID = "test-zone";
process.env.CLOUDFLARE_USER_API_TOKEN = "test-token";
process.env.NEXT_PUBLIC_DOMAIN = "test.com";

// Mock global fetch
global.fetch = jest.fn();

// Mock TextEncoder and TextDecoder for Node.js compatibility
const { TextEncoder, TextDecoder } = require("util");
global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;

// Mock Request for Next.js compatibility
global.Request = class MockRequest {
  constructor(url, init = {}) {
    this.url = url;
    this.method = init.method || "GET";
    this.headers = init.headers || {};
    this.body = init.body;
  }
};

// Mock console methods to reduce test noise
global.console = {
  ...console,
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

// Mock File constructor for upload tests
global.File = class MockFile {
  constructor(bits, name, options = {}) {
    this.bits = bits;
    this.name = name;
    this.type = options.type || "application/octet-stream";
    this.size =
      options.size ||
      (Array.isArray(bits)
        ? bits.reduce((size, bit) => size + (bit.length || 0), 0)
        : bits.length || 0);
    this.lastModified = options.lastModified || Date.now();
  }

  arrayBuffer() {
    return Promise.resolve(new ArrayBuffer(this.size));
  }

  text() {
    return Promise.resolve(this.bits.join(""));
  }
};

// Mock FormData
global.FormData = class MockFormData {
  constructor() {
    this.data = new Map();
  }

  append(key, value) {
    if (this.data.has(key)) {
      const existing = this.data.get(key);
      this.data.set(
        key,
        Array.isArray(existing) ? [...existing, value] : [existing, value],
      );
    } else {
      this.data.set(key, value);
    }
  }

  get(key) {
    const value = this.data.get(key);
    return Array.isArray(value) ? value[0] : value;
  }

  getAll(key) {
    const value = this.data.get(key);
    return Array.isArray(value) ? value : [value];
  }

  has(key) {
    return this.data.has(key);
  }

  set(key, value) {
    this.data.set(key, value);
  }

  delete(key) {
    this.data.delete(key);
  }
};

// Setup test timeout
jest.setTimeout(10000);
