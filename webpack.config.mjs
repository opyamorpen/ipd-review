import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
function findWebpackEntry() {
  const pnpmDir = join(__dirname, 'node_modules', '.pnpm')
  for (const entry of readdirSync(pnpmDir)) {
    if (!entry.startsWith('webpack@')) continue
    const candidate = join(pnpmDir, entry, 'node_modules', 'webpack', 'lib', 'index.js')
    if (existsSync(candidate)) return candidate
  }
  throw new Error('Cannot locate webpack package under node_modules/.pnpm')
}
function findPackageRoot(packageName) {
  const pnpmDirs = [
    join(__dirname, 'node_modules', '.pnpm'),
    join(__dirname, 'web', 'node_modules', '.pnpm'),
  ]
  for (const pnpmDir of pnpmDirs) {
    if (!existsSync(pnpmDir)) continue
    for (const entry of readdirSync(pnpmDir)) {
      const candidate = join(pnpmDir, entry, 'node_modules', packageName)
      if (existsSync(join(candidate, 'package.json'))) return candidate
    }
  }
  throw new Error(`Cannot locate package ${packageName} under node_modules/.pnpm or web/node_modules/.pnpm`)
}
const webpack = require(findWebpackEntry())
const pluginYamlPath = join(__dirname, 'config', 'plugin.yaml')
const pluginConfig = load(readFileSync(pluginYamlPath, 'utf8'))
const version = pluginConfig?.service?.version ?? ''
const moduleAboutBlankIDArray =
  pluginConfig?.modules
    ?.filter((module) => module?.moduleType === 'about:blank')
    ?.map((module) => module?.id)
    ?.filter((id) => id != null && id !== '') ?? []

/**
 * @param {import('webpack').Configuration} config
 * @param {import('@ones-op/rc-cli').WebpackConfigPipelineContext} context
 * @returns {import('webpack').Configuration}
 */
export default function defineWebpackConfig(config, context) {
  // console.log('--------------------------------')
  // console.log('defineWebpackConfig')
  // console.log('config', config)
  // console.log('context', context)
  // console.log('--------------------------------')
  const plugins = config.plugins || []
  const loaderAlias = {
    'babel-loader': findPackageRoot('babel-loader'),
    'css-loader': findPackageRoot('css-loader'),
    'postcss-loader': findPackageRoot('postcss-loader'),
    '@svgr/webpack': findPackageRoot('@svgr/webpack'),
  }
  config.resolveLoader = {
    ...(config.resolveLoader || {}),
    alias: {
      ...((config.resolveLoader && config.resolveLoader.alias) || {}),
      ...loaderAlias,
    },
  }
  config.plugins = [
    new webpack.DefinePlugin({
      'process.env.FRONTEND_CUSTOM_VALUE': JSON.stringify('frontend-custom-value'),
      'process.env.VERSION': JSON.stringify(version),
      'process.env.MODULE_ABOUT_BLANK_ID_ARRAY': JSON.stringify(moduleAboutBlankIDArray),
    }),
    ...plugins,
  ]
  return config
}
