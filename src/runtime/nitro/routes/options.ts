import { createError, defineEventHandler, getQuery } from 'h3'
import { withoutBase } from 'ufo'
import type { OgImageOptions } from '../../types'
import { extractAndNormaliseOgImageOptions } from '../utils'
import { getRouteRules } from '#internal/nitro'
import { useRuntimeConfig } from '#imports'

export default defineEventHandler(async (e) => {
  const query = getQuery(e)
  const path = withoutBase(query.path as string || '/', useRuntimeConfig().app.baseURL)

  // extract the payload from the original path
  let html: string
  try {
    html = await globalThis.$fetch(path)
  }
  catch (err) {
    throw createError({
      statusCode: 500,
      statusMessage: `Failed to read the path ${path} for og-image extraction. ${err.message}.`,
    })
  }

  e.node.req.url = path
  const oldRouteRules = e.context._nitro.routeRules
  e.context._nitro.routeRules = undefined
  const routeRules = (getRouteRules(e)?.ogImage || {}) as false | OgImageOptions
  e.context._nitro.routeRules = oldRouteRules
  e.node.req.url = e.path

  // has been disabled via route rules
  if (routeRules === false)
    return false

  const { defaults } = useRuntimeConfig()['nuxt-og-image']
  const payload = extractAndNormaliseOgImageOptions(path, html!, routeRules, defaults)
  // not supported
  if (!payload) {
    throw createError({
      statusCode: 500,
      statusMessage: `The path ${path} is missing the og-image payload.`,
    })
  }

  // need to hackily reset the event params so we can access the route rules of the base URL
  return payload
})
