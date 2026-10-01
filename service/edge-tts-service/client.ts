import { ArrayBufferChunks, arrayBufferToString } from '../utils'
import axios from 'axios'
import { createHash } from 'node:crypto'
import { WebSocket } from 'ws'

export const CHROMIUM_FULL_VERSION = '144.0.3719.82'
export const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const WINDOWS_FILE_TIME_EPOCH = 11644473600n
/** 单次合成请求的超时时间（毫秒） */
const REQUEST_TIMEOUT_MS = 60000

class MessageHeader {
    requestId: string
    contentType?: string
    path: string
    streamId?: string
    constructor(requestId: string, path: string, contentType?: string, streamId?: string) {
        this.requestId = requestId
        this.contentType = contentType
        this.path = path
        this.streamId = streamId
    }
    public static parse(data: string): MessageHeader {
        // 逐行解析，按第一个冒号切分，键名统一小写后取值。
        // 原实现有两个真实缺陷（已用真实/边界样本对照验证）：
        //  1) /X-RequestId:(?<id>[a-z|0-9]*)/ 遇到大写字符就截断，
        //     "0123456789ABCDEF" 只能取到 "0123456789"；一旦与本地 requestId
        //     不相等，音频帧会被全部丢弃，最终超时失败。
        //  2) /Path:(?<path>.*)\s/ 依赖值后面必须有空白字符，且会带上尾随空格：
        //     "Path:turn.end"（无尾随空白）直接抛 Path not found，
        //     "Path:audio " 会得到 "audio " 从而 switch 匹配不上。
        // 逐行解析 + trim 之后这两种情况都不再存在。
        const fields = new Map<string, string>()
        for (const line of data.split('\r\n')) {
            if (!line) {
                continue
            }
            const separatorIndex = line.indexOf(':')
            if (separatorIndex <= 0) {
                continue
            }
            const key = line.slice(0, separatorIndex).trim().toLowerCase()
            const value = line.slice(separatorIndex + 1).trim()
            if (!fields.has(key)) {
                fields.set(key, value)
            }
        }
        const requestId = fields.get('x-requestid')
        const path = fields.get('path')
        if (!requestId) {
            throw new Error('RequestId not found: \n' + data)
        }
        if (!path) {
            throw new Error('Path not found: \n' + data)
        }
        return new MessageHeader(
            requestId,
            path,
            fields.get('content-type'),
            fields.get('x-streamid'),
        )
    }

    public toString(): string {
        let header = `X-RequestId:${this.requestId}\r\n`
        header += `Content-Type:${this.contentType}; charset=UTF-8\r\n`
        if (this.streamId) {
            header += `X-StreamId:${this.streamId}\r\n`
        }
        header += `Path:${this.path}\r\n`
        return header
    }
}

function createConfigMessage(options: ClientOptions) {
    return {
        context: {
            synthesis: {
                audio: {
                    metadataoptions: {
                        sentenceBoundaryEnabled: options.sentenceBoundaryEnabled ? 'true' : 'false',
                        wordBoundaryEnabled: options.wordBoundaryEnabled ? 'true' : 'false',
                    },
                    outputFormat: options.format,
                },
            },
        },
    }
}

export interface ClientOptions {
    format: string
    sentenceBoundaryEnabled?: boolean
    wordBoundaryEnabled?: boolean
}

export interface ConvertResult {
    audio: ArrayBuffer
    metadata: any[]
}

export class EdgeTTSClient {
    private constructor() {
    }
    public static async voices(): Promise<any> {
        const url = 'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4'
        const response = await axios.get(url)
        const data = response.data
        return data
    }

    private static generateSecMsGecToken() {
        const ticks = BigInt(Math.floor((Date.now() / 1000) + Number(WINDOWS_FILE_TIME_EPOCH))) * 10000000n
        const roundedTicks = ticks - (ticks % 3000000000n)

        const strToHash = `${roundedTicks}${TRUSTED_CLIENT_TOKEN}`

        const hash = createHash('sha256')
        hash.update(strToHash, 'ascii')

        return hash.digest('hex').toUpperCase()
    }

    private static generateId(): String {
        const charset = "abcdef0123456789";
        let randomString = "";
        for (let i = 0; i < 32; i++) { // 16字节 * 2字符/字节 = 32字符
            const randomIndex = Math.floor(Math.random() * charset.length);
            randomString += charset.charAt(randomIndex);
        }
        return randomString;
    }
    private static async createWS(): Promise<WebSocket> {
        const connectionId = this.generateId()
        const secMsGec = this.generateSecMsGecToken()
        let url = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=1-${CHROMIUM_FULL_VERSION}&ConnectionId=${connectionId}`
        const client = new WebSocket(url, {
            host: 'speech.platform.bing.com',
            origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
            headers: {
                // Sec-MS-GEC / Sec-MS-GEC-Version 除了查询串，还必须在请求头里带一份，
                // 否则部分边缘节点（或高负载时）会直接返回 403。
                'Sec-MS-GEC': secMsGec,
                'Sec-MS-GEC-Version': `1-${CHROMIUM_FULL_VERSION}`,
                'Pragma': 'no-cache',
                'Cache-Control': 'no-cache',
                'Accept-Encoding': 'gzip, deflate, br',
                'Accept-Language': 'en-US,en;q=0.9',
                'User-Agent':
                    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 Edg/144.0.0.0',
            },
        })
        return new Promise((resolve, reject) => {
            client.onopen = () => {
                console.debug('WebSocket connected')
                resolve(client)
            }

            client.onerror = (error) => {
                console.error('WebSocket error:', error)
                reject(error)
            }
        })
    }

    public static async convert(ssml: string, options: ClientOptions): Promise<ConvertResult> {
        console.debug('start convert', JSON.stringify(ssml), JSON.stringify(options))
        let socket: WebSocket | null = null
        let settled = false
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null

        // 统一收尾：清掉超时定时器、关闭连接。
        // 旧实现里成功返回后定时器依然存活（10 分钟悬挂定时器，会拖住
        // serverless 实例），超时/异常时 WebSocket 也不会关闭。
        // 注意顺序：先把 socket 置空，再 close()。否则 close() 触发的 onclose
        // 会回调 fail() -> cleanup()，形成重入。
        const cleanup = () => {
            if (timeoutHandle !== null) {
                clearTimeout(timeoutHandle)
                timeoutHandle = null
            }
            const closing = socket
            socket = null
            if (closing !== null) {
                try {
                    if (closing.readyState === WebSocket.OPEN) {
                        closing.close(1000, '正常关闭')
                    } else if (closing.readyState === WebSocket.CONNECTING) {
                        closing.terminate()
                    }
                } catch (error) {
                    console.debug('close websocket failed', error)
                }
            }
        }

        const convertResult = new Promise<ConvertResult>(async (resolve, reject) => {
            const fail = (error: unknown) => {
                if (settled) {
                    return
                }
                settled = true
                cleanup()
                reject(error)
            }
            const succeed = (result: ConvertResult) => {
                if (settled) {
                    return
                }
                settled = true
                cleanup()
                resolve(result)
            }
            try {
                const audioChunks = new ArrayBufferChunks()
                let metadata: any = []
                const requestId = this.generateId()
                const ws = await this.createWS()
                if (settled) {
                    // 等待握手期间已经被超时/异常收尾
                    try { ws.terminate() } catch { /* ignore */ }
                    return
                }
                socket = ws
                ws.onclose = (r) => {
                    console.debug(`Websocket closed with ${r.code}`)
                    if (r.code !== 1000) {
                        fail(new Error(`WebSocket closed with code ${r.code}: ${r.reason}`))
                    }
                }
                ws.onmessage = (message) => {
                    const messageType = message.data.valueOf()
                    let typeName = 'unknow'
                    if (messageType instanceof Buffer) {
                        typeName = 'buffer'
                    } else if (typeof messageType === 'string') {
                        typeName = 'string'
                    } else {
                        typeName = 'object'
                    }
                    console.debug(`Received ${typeName} message`,)
                    if (message.data instanceof Buffer) {
                        let messageData = new Uint8Array(message.data).buffer
                        const headerRangeByteCount = 2
                        let [headerStart, headerLength] = Array.from(new Uint8Array(messageData.slice(0, 2)))
                        const headerData = messageData.slice(headerStart, headerRangeByteCount + headerLength)
                        const headerPayload = headerData.slice(headerRangeByteCount, headerData.byteLength)
                        let headerString = arrayBufferToString(headerPayload)
                        const header = MessageHeader.parse(headerString)
                        const data = messageData.slice(headerLength + headerRangeByteCount)
                        console.debug('Received binary data:', header.requestId, 'StreamId:', header.streamId, 'Path:', header.path, 'Length:', data.byteLength)
                        if (header.requestId === requestId) {
                            audioChunks.push(data)
                        }
                    } else if (typeof message.data === 'string') {
                        const spliter = '\r\n\r\n';
                        const messageData = message.data as string
                        const headerStringEnd = messageData.indexOf(spliter) + spliter.length
                        const headerString = messageData.slice(0, headerStringEnd)
                        const header = MessageHeader.parse(headerString)
                        const body = messageData.slice(headerStringEnd)
                        console.debug('Received text data:', header.requestId, 'StreamId:', header.streamId, 'Path:', header.path, 'Body', body)
                        switch (header.path) {
                            case 'turn.start': {
                                break
                            }
                            case 'audio.metadata': {
                                if (!body) {
                                    break
                                }
                                try {
                                    const data = JSON.parse(body)
                                    if (data && data["Metadata"] instanceof Array) {
                                        metadata.push(...data["Metadata"])
                                    }
                                } catch (error) {
                                    // 元数据解析失败不应该让整段语音失败
                                    console.debug('解析 audio.metadata 失败，已忽略', error)
                                }
                                break
                            }
                            case 'turn.end': {
                                if (header.requestId === requestId) {
                                    succeed({ audio: audioChunks.concat(), metadata })
                                    console.debug(`Client close requestId:${requestId}`)
                                }
                                break
                            }
                        }
                    }
                }
                // 发送配置消息
                let config = createConfigMessage(options)
                let configMessage =
                    `X-Timestamp:${Date()}\r\n` +
                    'Content-Type:application/json; charset=utf-8\r\n' +
                    'Path:speech.config\r\n\r\n' +
                    JSON.stringify(config)
                console.debug(`开始转换：${requestId}...`)
                console.debug(`准备发送配置请求：\n${configMessage}`)
                ws.send(
                    configMessage,
                    (error) => {
                        if (error) {
                            fail(error)
                        } else {
                            // 发送SSML消息
                            let ssmlMessage =
                                `X-Timestamp:${Date()}\r\n` +
                                `X-RequestId:${requestId}\r\n` +
                                `Content-Type:application/ssml+xml\r\n` +
                                `Path:ssml\r\n\r\n` +
                                ssml
                            console.debug(`发送转换信息：\n${ssmlMessage}`)
                            ws.send(
                                ssmlMessage, (error) => {
                                    if (error) {
                                        fail(error)
                                    }
                                })
                        }
                    }
                )
            } catch (e) {
                fail(e)
            }

        })
        const result: Promise<ConvertResult> = Promise.race([
            convertResult,
            new Promise<ConvertResult>((_, reject) => {
                timeoutHandle = setTimeout(() => {
                    if (settled) {
                        return
                    }
                    settled = true
                    cleanup()
                    reject(new Error('请求超时'))
                }, REQUEST_TIMEOUT_MS)
            }),
        ])

        return await result
    }
}
