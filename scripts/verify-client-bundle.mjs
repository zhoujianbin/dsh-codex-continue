import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
let registration

vm.runInNewContext(source, {
  window: {
    __ModuleLoader__: {
      load(value) {
        registration = value
      },
    },
  },
})

assert.equal(registration?.id, 'dsh-codex-continue', 'client bundle must register the package id')
assert.equal(typeof registration?.factory, 'function', 'client bundle must register a module factory')

const plugin = registration.factory((specifier) => {
  if (specifier === 'react') {
    return {
      createElement() {},
      useEffect() {},
      useState() {},
    }
  }
  throw new Error(`unexpected client external: ${specifier}`)
})

assert.equal(typeof plugin.apply, 'function', 'client bundle must export apply')
assert.ok(Array.isArray(plugin.inject), 'client bundle must export inject')
