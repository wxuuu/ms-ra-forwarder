import { EdgeTTSClient } from './client'
import { Speech, SpeechBoundary, TTSOptions, TTSService, Voice } from '../tts-service'
import { SSML } from '../ssml'


export class EdgeTTSService implements TTSService {

    async convert(text: string, options: TTSOptions): Promise<Speech> {
        const ssml = new SSML(text, options.voice, options.volume, options.rate, options.pitch)
        return await this.convertSSML(ssml.toString())
    }
    private async convertSSML(ssml: string): Promise<Speech> {
        const result = await EdgeTTSClient.convert(ssml, {
            format: "audio-24khz-96kbitrate-mono-mp3",
            sentenceBoundaryEnabled: false,
            wordBoundaryEnabled: false,
        })
        return {
            audio: result.audio,
            sentenceBoundaries: this.toBoundaries(result.metadata, "SentenceBoundary"),
            wordBoundaries: this.toBoundaries(result.metadata, "WordBoundary"),
        }
    }

    /**
     * 把微软返回的 audio.metadata 转成时间轴数据。
     * 注意：只有把 sentenceBoundaryEnabled / wordBoundaryEnabled 打开，
     * 服务端才会下发这两类元数据（当前配置为关闭，因此通常为空数组）。
     * 旧实现里 `data["Data"]["text"]["Text"]` 一旦被触发就会抛 TypeError：
     * 服务端返回的文本字段是 `Data.text.Text`（小写 text），且没有做空值保护。
     */
    private toBoundaries(metadata: any[], type: string): SpeechBoundary[] {
        if (!Array.isArray(metadata)) {
            return []
        }
        return metadata
            .filter((item: any) => item?.["Type"] === type)
            .map((item: any) => {
                const data = item?.["Data"] ?? {}
                const offset = Number(data["Offset"] ?? 0)
                const duration = Number(data["Duration"] ?? 0)
                const text = data["text"] ?? {}
                return {
                    start: offset / 10000,
                    end: (offset + duration) / 10000,
                    duration: duration / 10000,
                    text: String(text["Text"] ?? ''),
                    length: String(text["Length"] ?? ''),
                }
            })
    }

    async fetchVoices(): Promise<Array<Voice>> {
        const data = await EdgeTTSClient.voices()
        let voices = data.map((item: any) => {
            const voice: Voice = {
                label: item['FriendlyName'],
                gender: item['Gender'],
                value: item['Name'],
                locale: item['Locale'],
                format: item['SuggestedCodec'],
                // VoiceTag 可能整个缺失（部分音色没有 VoicePersonalities），
                // 旧实现直接 item['VoiceTag'][...] 会抛 TypeError，
                // 且 ?. 之后仍可能是 undefined，与 Voice 类型不符。
                personalities: Array.isArray(item?.['VoiceTag']?.['VoicePersonalities'])
                    ? item['VoiceTag']['VoicePersonalities']
                    : [],
            }
            return voice
        })
        return voices
    }

}
