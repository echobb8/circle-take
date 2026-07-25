/**
 * Character kit file handling: reference stills are COPIED into the project
 * (`kits/<charId>/`) rather than referenced in place, because a kit is the
 * identity contract for the whole film — it must survive the source images
 * being moved or deleted.
 */

import { copyFile, mkdir, rm } from 'fs/promises'
import { basename, extname, join } from 'path'
import type { CharacterKit } from '../shared/types'
import * as project from './project'

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff']

export function isImageFile(path: string): boolean {
  return IMAGE_EXTENSIONS.includes(extname(path).toLowerCase())
}

/** Make `name.jpg` unique inside a kit folder: `name.jpg`, `name-2.jpg`, … */
function uniqueName(taken: Set<string>, fileName: string): string {
  if (!taken.has(fileName)) return fileName
  const ext = extname(fileName)
  const stem = fileName.slice(0, fileName.length - ext.length)
  for (let i = 2; ; i++) {
    const candidate = `${stem}-${i}${ext}`
    if (!taken.has(candidate)) return candidate
  }
}

/** Copy stills into the kit folder and register their project-relative paths. */
export async function addKitImages(charId: string, imagePaths: string[]): Promise<CharacterKit> {
  const char = project.findCharacter(charId)
  if (!char) throw new Error(`No character with id ${charId}`)

  const dir = project.kitsDir(charId)
  await mkdir(dir, { recursive: true })

  const taken = new Set(char.images.map((rel) => basename(rel)))
  const added: string[] = []

  for (const src of imagePaths) {
    if (!isImageFile(src)) continue
    const name = uniqueName(taken, basename(src))
    taken.add(name)
    await copyFile(src, join(dir, name))
    added.push(`kits/${charId}/${name}`)
  }

  if (added.length === 0) {
    throw new Error('No supported image files were provided (jpg, png, webp, bmp, tif).')
  }

  project.registerKitImages(charId, added)
  const updated = project.findCharacter(charId)
  if (!updated) throw new Error(`Character ${charId} disappeared while adding images.`)
  return updated
}

/** Remove one still from a kit (project-relative path or bare file name). */
export async function removeKitImage(charId: string, image: string): Promise<CharacterKit> {
  const char = project.findCharacter(charId)
  if (!char) throw new Error(`No character with id ${charId}`)
  await rm(join(project.kitsDir(charId), basename(image)), { force: true }).catch(() => {})
  project.removeKitImage(charId, image)
  const updated = project.findCharacter(charId)
  if (!updated) throw new Error(`Character ${charId} disappeared while removing an image.`)
  return updated
}
