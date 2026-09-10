import replace from '@rollup/plugin-replace'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import ts from 'typescript'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const pluginYamlPath = join(__dirname, 'config', 'plugin.yaml')
const pluginConfig = load(readFileSync(pluginYamlPath, 'utf8'))
const version = pluginConfig?.service?.version ?? ''
const fetchNodeDistPath = join(dirname(require.resolve('@ones-op/fetch/package.json')), 'dist', 'node', 'index.js')
const moduleAboutBlankIDArray =
  pluginConfig?.modules
    ?.filter((module) => module?.moduleType === 'about:blank')
    ?.map((module) => module?.id)
    ?.filter((id) => id != null && id !== '') ?? []

function forceOnesFetchNodeDist() {
  return {
    name: 'force-ones-fetch-node-dist',
    resolveId(source) {
      return source === '@ones-op/fetch' ? fetchNodeDistPath : null
    },
  }
}

function stripTypeScriptSyntax() {
  return {
    name: 'strip-typescript-syntax',
    transform(code, id) {
      if (!id.includes('/backend/src/') || !id.endsWith('.ts')) return null
      const result = ts.transpileModule(code, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2020,
          jsx: ts.JsxEmit.React,
          esModuleInterop: true,
        },
        fileName: id,
        reportDiagnostics: false,
      })
      return { code: result.outputText, map: result.sourceMapText ? JSON.parse(result.sourceMapText) : null }
    },
  }
}

/**
 * @param {import('rollup').RollupOptions} config
 * @param {import('@ones-op/rc-cli').RollupConfigPipelineContext} context
 * @returns {import('rollup').RollupOptions}
 */
export default function defineRollupConfig(config, context) {
  // console.log('--------------------------------')
  // console.log('defineRollupConfig')
  // console.log('config', config)
  // console.log('context', context)
  // console.log('--------------------------------')
  const plugins = config.plugins || []
  config.plugins = [
    stripTypeScriptSyntax(),
    forceOnesFetchNodeDist(),
    replace({
      preventAssignment: true,
      'process.env.BACKEND_CUSTOM_VALUE': JSON.stringify('backend-custom-value'),
      'process.env.VERSION': JSON.stringify(version),
      'process.env.MODULE_ABOUT_BLANK_ID_ARRAY': JSON.stringify(moduleAboutBlankIDArray),
    }),
    ...plugins,
  ]
  return config
}
