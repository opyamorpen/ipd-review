import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
function findWebpackEntry() {
  // 优先标准 npm 解析；pnpm 布局（node_modules/.pnpm）作为后备。
  try {
    return require.resolve('webpack')
  } catch {
    /* 走 pnpm 后备 */
  }
  const pnpmDir = join(__dirname, 'node_modules', '.pnpm')
  if (existsSync(pnpmDir)) {
    for (const entry of readdirSync(pnpmDir)) {
      if (!entry.startsWith('webpack@')) continue
      const candidate = join(pnpmDir, entry, 'node_modules', 'webpack', 'lib', 'index.js')
      if (existsSync(candidate)) return candidate
    }
  }
  throw new Error('Cannot locate webpack package (require.resolve 与 node_modules/.pnpm 均未找到)')
}
function findPackageRoot(packageName) {
  // 优先标准 npm 解析：先试 package.json 子路径（exports 字段可能拦截），
  // 失败则解析包入口后向上回溯到含 package.json 的目录；pnpm 布局作为后备。
  try {
    return dirname(require.resolve(join(packageName, 'package.json')))
  } catch {
    /* exports 拦截或缺失，继续 */
  }
  try {
    let dir = dirname(require.resolve(packageName))
    for (let i = 0; i < 5 && dir !== '/'; i++) {
      if (existsSync(join(dir, 'package.json'))) return dir
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    /* 走 pnpm 后备 */
  }
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
  throw new Error(`Cannot locate package ${packageName} (npm 解析与 pnpm 目录均未找到)`)
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
