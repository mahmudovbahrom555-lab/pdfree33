import js from '@eslint/js';
import compat from 'eslint-plugin-compat';

export default [
  js.configs.recommended,
  {
    plugins: { compat },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType:  'module',
      globals: {
        window: 'readonly', document: 'readonly', navigator: 'readonly',
        console: 'readonly', fetch: 'readonly', URL: 'readonly',
        URLSearchParams: 'readonly', CustomEvent: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly',
        requestAnimationFrame: 'readonly', requestIdleCallback: 'readonly',
        Worker: 'readonly', File: 'readonly', Blob: 'readonly',
        FileReader: 'readonly', Promise: 'readonly', performance: 'readonly',
        history: 'readonly', location: 'readonly', caches: 'readonly',
        self: 'readonly', clients: 'readonly', importScripts: 'readonly',
        Response: 'readonly', Request: 'readonly', Event: 'readonly',
        MutationObserver: 'readonly', ResizeObserver: 'readonly',
        AbortController: 'readonly', TextDecoder: 'readonly',
        // Worker-scope globals
        createImageBitmap: 'readonly', OffscreenCanvas: 'readonly',
        ImageData: 'readonly', ImageBitmap: 'readonly',
        // CDN globals loaded at runtime
        PDFLib: 'readonly', JSZip: 'readonly', pdfjsLib: 'readonly',
        // Standard browser/worker APIs
        Image: 'readonly', prompt: 'readonly', alert: 'readonly',
        TextEncoder: 'readonly', crypto: 'readonly',
        structuredClone: 'readonly', queueMicrotask: 'readonly',
        btoa: 'readonly', atob: 'readonly', module: 'readonly',
        localStorage: 'readonly',
        MessageChannel: 'readonly',
        encryptPDF: 'readonly',
      },
    },
    rules: {
      'no-unused-vars':       ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-undef':             'error',
      'no-console':           'off',
      'no-empty':             ['error', { allowEmptyCatch: false }],
      'no-useless-assignment': 'off',   // false positives on defensive 0-init pattern
      'compat/compat':        'warn',   // flags APIs missing in iOS Safari 14+
    },
    settings: {
      // Target real browsers — exclude Opera Mini (no JS engine capable of PDF processing)
      browsers: ['last 2 Chrome versions', 'last 2 Firefox versions',
                 'last 2 Safari versions', 'iOS >= 14', 'last 2 Edge versions'],
      lintAllEsApis: false,
    },
    files: ['js/*.js'],
    ignores: ['js/vendor/**'],
  },
];
