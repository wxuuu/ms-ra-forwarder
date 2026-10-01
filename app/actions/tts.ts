'use server'

import { EdgeTTSService } from '@/service/edge-tts-service'
import { TTSOptions, Voice } from '@/service/tts-service'
import Keyv from 'keyv'

const voicesCache = new Keyv<Voice[]>(undefined, {
    ttl: 1000 * 60 * 60, // 1小时缓存
})

/**
 * 上一次成功获取到的音色列表。
 * 微软的 voices/list 接口偶发抖动时，getVoices() 不应该把整个前端
 * （下拉框、二维码、朗读规则）一起拖挂，这里做一层兜底。
 */
let lastGoodVoices: Voice[] | null = null

async function getVoices() {
    let voices: Voice[] | undefined = await voicesCache.get('voices')

    if (!voices) {
        try {
            const service = new EdgeTTSService()
            voices = await service.fetchVoices()
            await voicesCache.set('voices', voices)
            lastGoodVoices = voices
        } catch (error) {
            console.error('获取音色列表失败', error)
            if (lastGoodVoices) {
                return lastGoodVoices
            }
            // 首次获取就失败：返回空列表，让页面能正常渲染并提示，而不是整页报错
            return []
        }
    }
    return voices
}

export async function listLocales() {
    const voices = await getVoices()
    return voices?.map(voice => voice.locale).filter((value, index, self) => self.indexOf(value) === index) ?? []
}

export async function listVoices(locale?: string) {
    const voices = await getVoices()
    if (locale) {
        return voices?.filter(voice => voice.locale === locale) ?? []
    }
    return voices ?? []
}

export async function textToSpeach(text: string, options: TTSOptions) {
    try {
        const service = new EdgeTTSService()
        const data = await service.convert(text, options)
        const base64Audio = Buffer.from(data.audio).toString('base64')
        return base64Audio
    } catch (error) {
        console.log('textToSpeach error', error)
        throw error
    }
}