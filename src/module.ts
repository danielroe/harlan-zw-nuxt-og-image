import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'fs'
import type { NitroRouteRules } from 'nitropack'
import {
  addComponent,
  addImports,
  addServerHandler,
  addTemplate,
  createResolver,
  defineNuxtModule,
  getNuxtVersion,
  useLogger,
} from '@nuxt/kit'
import { execa } from 'execa'
import chalk from 'chalk'
import defu from 'defu'
import { createRouter as createRadixRouter, toRouteMatcher } from 'radix3'
import { joinURL } from 'ufo'
import { join, relative } from 'pathe'
import type { Browser } from 'playwright-core'
import { tinyws } from 'tinyws'
import sirv from 'sirv'
import type { SatoriOptions } from 'satori'
import { copy } from 'fs-extra'
import { createBrowser } from './runtime/nitro/browsers/default'
import { screenshot } from './runtime/browserUtil'
import type { OgImageOptions, ScreenshotOptions } from './types'
import { setupPlaygroundRPC } from './rpc'
import { exposeModuleConfig } from './nuxt-utils'
import { extractOgImageOptions, stripOgImageOptions } from './utils'

export interface ModuleOptions {
  /**
   * The hostname of your website.
   */
  host: string
  defaults: OgImageOptions
  experimentalNitroBrowser: boolean
  fonts: `${string}:${number}`[]
  satoriOptions: Partial<SatoriOptions>
  forcePrerender: boolean
}

const PATH = '/__nuxt_og_image__'
const PATH_ENTRY = `${PATH}/entry`
const PATH_PLAYGROUND = `${PATH}/client`

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: 'nuxt-og-image',
    compatibility: {
      nuxt: '^3.0.0',
      bridge: false,
    },
    configKey: 'ogImage',
  },
  defaults(nuxt) {
    return {
      experimentalNitroBrowser: false,
      // when we run `nuxi generate` we need to force prerendering
      forcePrerender: !nuxt.options.dev && nuxt.options._generate,
      host: nuxt.options.runtimeConfig.public?.siteUrl,
      defaults: {
        component: 'OgImageBasic',
        width: 1200,
        height: 630,
      },
      fonts: [],
      satoriOptions: {},
    }
  },
  async setup(config, nuxt) {
    const { resolve } = createResolver(import.meta.url)

    // default font is inter
    if (!config.fonts.length)
      config.fonts = ['Inter:400', 'Inter:700']

    const distResolve = (p: string) => {
      const cwd = resolve('.')
      if (cwd.endsWith('/dist'))
        return resolve(p)
      return resolve(`../dist/${p}`)
    }

    // @ts-expect-error need edge schema
    nuxt.options.experimental.componentIslands = true

    const isEdge = (process.env.NITRO_PRESET || '').includes('edge')
    const hasIslandSupport = getNuxtVersion(nuxt) !== '3.0.0'

    const logger = useLogger('nuxt-og-image')
    if (!hasIslandSupport)
      logger.warn('You are using Nuxt 3.0.0 with `nuxt-og-image`, which only supports screenshots.\nPlease upgrade to Nuxt 3.0.1 or the edge channel: https://nuxt.com/docs/guide/going-further/edge-channel.')

    // paths.d.ts
    addTemplate({
      filename: 'nuxt-og-image.d.ts',
      getContents: () => {
        return `// Generated by nuxt-og-image
interface NuxtOgImageNitroRules {
  ogImage?: false | Record<string, any>
}
declare module 'nitropack' {
  interface NitroRouteRules extends NuxtOgImageNitroRules {}
  interface NitroRouteConfig extends NuxtOgImageNitroRules {}
}
export {}
`
      },
    })

    nuxt.hooks.hook('prepare:types', ({ references }) => {
      references.push({ path: resolve(nuxt.options.buildDir, 'nuxt-og-image.d.ts') })
    })

    ;['html', 'options', 'svg', 'vnode', 'og.png']
      .forEach((type) => {
        addServerHandler({
          handler: resolve(`./runtime/nitro/routes/__og_image__/${type}`),
        })
      })

    addServerHandler({
      route: '/api/og-image-font',
      handler: resolve('./runtime/nitro/routes/__og_image__/font'),
    })

    // Setup playground. Only available in development
    if (nuxt.options.dev) {
      const playgroundDir = distResolve('./client')
      const {
        middleware: rpcMiddleware,
      } = setupPlaygroundRPC(nuxt, config)
      nuxt.hook('vite:serverCreated', (server) => {
        server.middlewares.use(PATH_ENTRY, tinyws() as any)
        server.middlewares.use(PATH_ENTRY, rpcMiddleware as any)
        // serve the front end in production
        if (existsSync(playgroundDir))
          server.middlewares.use(PATH_PLAYGROUND, sirv(playgroundDir, { single: true, dev: true }))
      })
      // allow /__og_image__ to be proxied
      addServerHandler({
        handler: resolve('./runtime/nitro/routes/__og_image__/index'),
      })
    }

    ['defineOgImageDynamic', 'defineOgImageStatic', 'defineOgImageScreenshot']
      .forEach((name) => {
        addImports({
          name,
          from: resolve('./runtime/composables/defineOgImage'),
        })
      })

    await addComponent({
      name: 'OgImageBasic',
      filePath: resolve('./runtime/components/OgImageBasic.island.vue'),
      global: true,
      // @ts-expect-error need to use @nuxt/kit edge
      island: true,
    })

    ;['OgImageStatic', 'OgImageDynamic', 'OgImageScreenshot']
      .forEach((name) => {
        addComponent({
          name,
          filePath: resolve(`./runtime/components/${name}`),
          // @ts-expect-error need to use @nuxt/kit edge
          island: true,
        })
      })

    const runtimeDir = resolve('./runtime')
    nuxt.options.build.transpile.push(runtimeDir)

    const fontDir = resolve(nuxt.options.buildDir, 'nuxt-og-image')
    const publicDirs = [`${nuxt.options.rootDir}/public`, fontDir]

    // add config to app and nitro
    exposeModuleConfig('nuxt-og-image', { ...config, publicDirs })

    // move the fonts into the build directory so we can access them at runtime
    nuxt.hooks.hook('build:before', async () => {
      await copy(resolve('./runtime/public'), resolve(nuxt.options.buildDir, 'nuxt-og-image'))
    })

    nuxt.hooks.hook('nitro:config', (nitroConfig) => {
      nitroConfig.externals = defu(nitroConfig.externals || {}, {
        inline: [runtimeDir],
      })

      nitroConfig.publicAssets = nitroConfig.publicAssets || []
      nitroConfig.publicAssets.push({ dir: fontDir, maxAge: 31536000 })
      nitroConfig.virtual!['#nuxt-og-image/browser'] = `export { createBrowser } from '${runtimeDir}/nitro/browsers/${isEdge ? 'lambda' : 'default'}'`
      nitroConfig.virtual!['#nuxt-og-image/provider'] = `
      import satori from '${runtimeDir}/nitro/providers/satori'
      import browser from '${runtimeDir}/nitro/providers/browser'

      export function useProvider(provider) {
        if (provider === 'satori')
          return satori
        if (provider === 'browser')
          return browser
      }
      `

      if (config.experimentalNitroBrowser) {
        nitroConfig.virtual!['#nuxt-og-image/providers/browser'] = `export * from '${runtimeDir}/nitro/providers/browser'`

        if (isEdge) {
          // we need to mock some of the static requires from chrome-aws-lambda, puppeteer-core is okay though
          ['puppeteer', 'bufferutil', 'utf-8-validate'].forEach((name) => {
            // @ts-expect-error untyped
            nitroConfig.alias[name] = 'unenv/runtime/mock/proxy'
          })
        }
      }
    })

    nuxt.hooks.hook('nitro:init', async (nitro) => {
      let screenshotQueue: OgImageOptions[] = []

      const _routeRulesMatcher = toRouteMatcher(
        createRadixRouter({ routes: nitro.options.routeRules }),
      )

      nitro.hooks.hook('prerender:generate', async (ctx) => {
        // avoid scanning files and the og:image route itself
        if (ctx.route.includes('.') || ctx.route.endsWith('__og_image__/html'))
          return

        const html = ctx.contents

        // we need valid _contents to scan for ogImage options and know the route is good
        if (!html)
          return

        const extractedOptions = extractOgImageOptions(html)
        ctx.contents = stripOgImageOptions(html)
        const routeRules: NitroRouteRules = defu({}, ..._routeRulesMatcher.matchAll(ctx.route).reverse())
        if (!extractedOptions || routeRules.ogImage === false)
          return

        const options: OgImageOptions = {
          path: ctx.route,
          ...extractedOptions,
          ...(routeRules.ogImage || {}),
          ctx,
        }

        // if we're running `nuxi generate` we pre-render everything (including dynamic)
        if ((nuxt.options._generate || options.prerender) && options.provider === 'browser')
          screenshotQueue.push(options)
      })

      if (nuxt.options.dev)
        return

      const captureScreenshots = async () => {
        if (screenshotQueue.length === 0)
          return

        const previewProcess = execa('npx', ['serve', nitro.options.output.publicDir])
        let browser: Browser | null = null
        try {
          previewProcess.stderr?.pipe(process.stderr)
          // wait until we get a message which says "Accepting connections"
          const host = (await new Promise<string>((resolve) => {
            previewProcess.stdout?.on('data', (data) => {
              if (data.includes('Accepting connections at')) {
                // get the url from data and return it as the promise
                resolve(data.toString().split('Accepting connections at ')[1])
              }
            })
          })).trim()
          browser = await createBrowser()
          if (browser) {
            nitro.logger.info(`Pre-rendering ${screenshotQueue.length} og:image screenshots...`)
            for (const k in screenshotQueue) {
              const entry = screenshotQueue[k]
              const start = Date.now()
              let hasError = false
              const dirname = joinURL(nitro.options.output.publicDir, `${entry.ctx.fileName.replace('index.html', '')}__og_image__/`)
              const filename = joinURL(dirname, '/og.png')
              try {
                const imgBuffer = await screenshot(browser, `${host}${entry.path}`, {
                  ...(config.defaults as ScreenshotOptions || {}),
                  ...(entry || {}),
                })
                try {
                  await mkdir(dirname, { recursive: true })
                }
                catch (e) {}
                await writeFile(filename, imgBuffer)
              }
              catch (e) {
                hasError = true
                console.error(e)
              }
              const generateTimeMS = Date.now() - start
              nitro.logger.log(chalk[hasError ? 'red' : 'gray'](
                `  ${Number(k) === screenshotQueue.length - 1 ? '└─' : '├─'} ${relative(nitro.options.output.publicDir, filename)} (${generateTimeMS}ms) ${Math.round((Number(k) + 1) / (screenshotQueue.length) * 100)}%`,
              ))
            }
          }
          else {
            nitro.logger.log(chalk.red('Failed to create a browser to create og:images.'))
          }
        }
        catch (e) {
          console.error(e)
        }
        finally {
          await browser?.close()
          previewProcess.kill()
        }
        screenshotQueue = []
      }

      // SSR mode
      nitro.hooks.hook('rollup:before', async () => {
        await captureScreenshots()
      })

      // SSG mode
      nitro.hooks.hook('close', async () => {
        await captureScreenshots()
      })
    })
  },
})
