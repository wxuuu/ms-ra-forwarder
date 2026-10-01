export const formatDate = (date: Date) => {
    const year = date.getFullYear()
    const month = date.getMonth() + 1
    const day = date.getDate()
    const hour = date.getHours()
    const minute = date.getMinutes()
    const second = date.getSeconds()

    return (
        [year, month, day].map(formatNumber).join('/') +
        ' ' +
        [hour, minute, second].map(formatNumber).join(':')
    )
}

export function arrayBufferToString(arrayBuffer: ArrayBuffer): string {
    const uint8Array = new Uint8Array(arrayBuffer);
    let resultString = "";

    for (let i = 0; i < uint8Array.length; i++) {
        resultString += String.fromCharCode(uint8Array[i]);
    }
    return resultString;
}

export function arrayBufferToArray(arrayBuffer: ArrayBuffer): Array<number> {
    const uint8Array = new Uint8Array(arrayBuffer);
    const array = Array.from(uint8Array);
    return array
}

// 音频是按块（每帧约几百字节到几 KB）推送的，
// 旧实现每收到一块就用 concatArrayBuffers 重新分配并整体复制一次，
// 文本稍长就是 O(n²) 的搬运量，长文本会明显变慢甚至吃满内存。
// 这里改成只收集分片，最后一次性合并。
export class ArrayBufferChunks {
    private chunks: Uint8Array[] = []
    private totalLength = 0

    push(chunk: ArrayBuffer | Uint8Array): void {
        const view = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
        if (view.byteLength === 0) {
            return
        }
        this.chunks.push(view)
        this.totalLength += view.byteLength
    }

    get length(): number {
        return this.totalLength
    }

    concat(): ArrayBuffer {
        if (this.chunks.length === 0) {
            return new ArrayBuffer(0)
        }
        if (this.chunks.length === 1) {
            const only = this.chunks[0]
            // 复制一份，避免返回的 buffer 带着更大的底层 ArrayBuffer
            return only.slice().buffer
        }
        const merged = new Uint8Array(this.totalLength)
        let offset = 0
        for (const chunk of this.chunks) {
            merged.set(chunk, offset)
            offset += chunk.byteLength
        }
        this.chunks = []
        this.totalLength = 0
        return merged.buffer
    }
}

export function concatArrayBuffers(buffer1: ArrayBuffer, buffer2: ArrayBuffer): ArrayBuffer {
    const merged = new ArrayBuffer(buffer1.byteLength + buffer2.byteLength);
    const view = new Uint8Array(merged);
    view.set(new Uint8Array(buffer1), 0);
    view.set(new Uint8Array(buffer2), buffer1.byteLength);
    return merged;
}

const formatNumber = (n: number) => {
    const s = n.toString()
    return s[1] ? s : '0' + s
}

export function classNames(...classes: string[]) {
    return classes.filter(Boolean).join(' ')
}

export function formatTime(time: number) {
    // output 00:00:00 or 00:00
    const hours = Math.floor(time / 3600);
    const minutes = Math.floor((time % 3600) / 60);
    const seconds = Math.floor(time % 60);
    if (hours === 0) {
        return [minutes, seconds].map(formatNumber).join(':')
    } else {
        return [hours, minutes, seconds].map(formatNumber).join(':')
    }
}

export function cls(...classNames: string[]) {
    return classNames.filter(Boolean).map(className => className.trim()).join(' ')
}