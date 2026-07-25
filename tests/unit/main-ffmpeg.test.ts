/**
 * ffmpeg/ffprobe argv builders and probe-JSON parsing. Pure functions only —
 * nothing here spawns a process or imports Electron.
 */

import { describe, it, expect } from 'vitest'
import {
  frameGrabArgs,
  formatSeconds,
  parseFraction,
  parseProbeJson,
  posterTimestamp,
  probeArgs,
  stripTimestamps,
  POSTER_WIDTH,
  STRIP_COUNT,
  STRIP_WIDTH,
} from '../../src/main/ffmpeg'

describe('probeArgs', () => {
  it('asks ffprobe for JSON with format and streams', () => {
    expect(probeArgs('/media/12A_take3.mp4')).toEqual([
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      '/media/12A_take3.mp4',
    ])
  })

  it('keeps the path as the last argument so spaces are never split', () => {
    const args = probeArgs('/Volumes/My Drive/shot 002.mov')
    expect(args[args.length - 1]).toBe('/Volumes/My Drive/shot 002.mov')
  })
})

describe('frameGrabArgs', () => {
  it('seeks before the input and writes exactly one frame', () => {
    const args = frameGrabArgs('/media/a.mp4', '/out/poster.jpg', 1.5, POSTER_WIDTH)
    expect(args).toEqual([
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      '1.500',
      '-i',
      '/media/a.mp4',
      '-frames:v',
      '1',
      '-vf',
      'scale=640:-2',
      '-q:v',
      '3',
      '/out/poster.jpg',
    ])
  })

  it('puts -ss before -i (fast seek)', () => {
    const args = frameGrabArgs('/media/a.mp4', '/out/s.jpg', 4, STRIP_WIDTH)
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'))
    expect(args).toContain('scale=240:-2')
  })
})

describe('formatSeconds', () => {
  it('is locale-free and clamps negatives to zero', () => {
    expect(formatSeconds(0)).toBe('0.000')
    expect(formatSeconds(-4)).toBe('0.000')
    expect(formatSeconds(12.3456)).toBe('12.346')
  })
})

describe('timestamps', () => {
  it('puts the poster at 25% of the duration', () => {
    expect(posterTimestamp(8)).toBe(2)
    expect(posterTimestamp(0)).toBe(0)
  })

  it('spaces filmstrip frames at slice centres, never at the very edges', () => {
    const stamps = stripTimestamps(8, STRIP_COUNT)
    expect(stamps).toHaveLength(8)
    expect(stamps[0]).toBeCloseTo(0.5)
    expect(stamps[7]).toBeCloseTo(7.5)
    expect(stamps[0]).toBeGreaterThan(0)
    expect(stamps[7]).toBeLessThan(8)
  })

  it('survives a zero-duration take', () => {
    expect(stripTimestamps(0)).toEqual(new Array(8).fill(0))
  })
})

describe('parseFraction', () => {
  it('parses ffprobe rate fractions', () => {
    expect(parseFraction('24/1')).toBe(24)
    expect(parseFraction('24000/1001')).toBe(23.976)
    expect(parseFraction('30000/1001')).toBe(29.97)
    expect(parseFraction('25')).toBe(25)
  })

  it('returns 0 for degenerate or missing values', () => {
    expect(parseFraction('0/0')).toBe(0)
    expect(parseFraction(undefined)).toBe(0)
    expect(parseFraction('abc')).toBe(0)
  })
})

describe('parseProbeJson', () => {
  it('reads the video stream and container duration', () => {
    const info = parseProbeJson({
      format: { duration: '4.208333' },
      streams: [
        { codec_type: 'audio', codec_name: 'aac' },
        {
          codec_type: 'video',
          codec_name: 'h264',
          width: 1920,
          height: 1080,
          r_frame_rate: '24/1',
        },
      ],
    })
    expect(info).toEqual({
      durationSec: 4.208333,
      fps: 24,
      width: 1920,
      height: 1080,
      codec: 'h264',
    })
  })

  it('falls back to avg_frame_rate when r_frame_rate is degenerate', () => {
    const info = parseProbeJson({
      format: { duration: '2' },
      streams: [
        {
          codec_type: 'video',
          codec_name: 'vp9',
          width: 1280,
          height: 720,
          r_frame_rate: '0/0',
          avg_frame_rate: '30000/1001',
        },
      ],
    })
    expect(info.fps).toBe(29.97)
    expect(info.codec).toBe('vp9')
  })

  it('degrades gracefully on garbage input', () => {
    expect(parseProbeJson(null)).toEqual({
      durationSec: 0,
      fps: 0,
      width: 0,
      height: 0,
      codec: 'unknown',
    })
  })
})
