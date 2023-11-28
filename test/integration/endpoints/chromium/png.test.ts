import { describe, expect, it } from 'vitest'
import { createResolver } from '@nuxt/kit'
import { $fetch, setup } from '@nuxt/test-utils'
import { toMatchImageSnapshot } from 'jest-image-snapshot'

const { resolve } = createResolver(import.meta.url)

await setup({
  rootDir: resolve('../../../fixtures/basic'),
})

expect.extend({ toMatchImageSnapshot })

describe('png', () => {
  it('basic', async () => {
    const png: ArrayBuffer = await $fetch('/__og-image__/image/chromium/og.png', {
      responseType: 'arrayBuffer',
    })
    // eslint-disable-next-line node/prefer-global/buffer
    expect(Buffer.from(png)).toMatchImageSnapshot()
  }, 60000)
})