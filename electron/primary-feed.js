import fs from 'node:fs/promises'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'

const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== ''

export async function loadPrimaryFeedConfig({ resourcesPath, readFileImpl = fs.readFile } = {}) {
  if (!isNonEmptyString(resourcesPath)) {
    throw new Error('The app resources path is unavailable, so the update feed cannot be loaded.')
  }

  const configPath = path.join(resourcesPath, 'app-update.yml')
  let contents
  try {
    contents = await readFileImpl(configPath, 'utf8')
  } catch (error) {
    throw new Error(`Could not read the update feed config at ${configPath}: ${error?.message ?? error}`)
  }

  let config
  try {
    config = parseYaml(contents)
  } catch (error) {
    throw new Error(`The update feed config at ${configPath} is not valid YAML: ${error?.message ?? error}`)
  }

  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`The update feed config at ${configPath} must be a YAML mapping.`)
  }
  if (!isNonEmptyString(config.provider)) {
    throw new Error(`The update feed config at ${configPath} must define a provider.`)
  }
  if (config.provider === 'github' && (!isNonEmptyString(config.owner) || !isNonEmptyString(config.repo))) {
    throw new Error(`The GitHub update feed config at ${configPath} must define owner and repo.`)
  }

  return config
}
