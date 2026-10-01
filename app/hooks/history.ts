import { TTSOptionsSchema } from "@/service/tts-service";
import { useCallback, useEffect, useRef, useState } from "react";
import { openDB, IDBPDatabase } from 'idb';
import { z } from "zod";

const DB_NAME = 'tts-history-db';
const STORE_NAME = 'history';
const DB_VERSION = 1;

export const HistoryRecordSchame = z.object({
    id: z.string().uuid(),
    uri: z.string(),
    text: z.string(),
    // 注意：这里不能用 .default()。zod 的 parse() 会把缺失字段补成默认值（0），
    // 而 save() 会把 parse 结果写回 IndexedDB，等于把旧记录的音量/语速/音调
    // 永久改写成 0（音量为 0 即静音），造成数据被破坏。
    options: TTSOptionsSchema,
    createAt: z.number()
})

export type HistoryRecord = z.infer<typeof HistoryRecordSchame>

export default function useHistory() {
    const [history, setHistory] = useState<HistoryRecord[]>([]);
    // const [db, setDb] = useState<IDBPDatabase | null>(null);
    const dbRef = useRef<IDBPDatabase | null>(null)
    const activeRef = useRef(true)

    // 初始化数据库
    useEffect(() => {
        activeRef.current = true
        const initDB = async () => {
            try {
                const newDb = await openDB(DB_NAME, DB_VERSION, {
                    upgrade(db) {
                        if (!db.objectStoreNames.contains(STORE_NAME)) {
                            db.createObjectStore(STORE_NAME, { keyPath: 'id' });
                        }
                    },
                });
                if (!activeRef.current) {
                    newDb.close()
                    return
                }
                // setDb(newDb);
                dbRef.current = newDb
                // 加载初始数据
                const allRecords = await newDb.getAll(STORE_NAME);
                if (!activeRef.current) {
                    return
                }
                setHistory(allRecords.sort((a, b) => b.createAt - a.createAt));
            } catch (error) {
                // openDB 失败（如浏览器禁用 IndexedDB、隐私模式）不应变成未捕获的
                // promise rejection，否则控制台报错且历史功能静默失效。
                console.error('初始化朗读历史数据库失败', error)
            }
        };

        initDB();
        return () => {
            activeRef.current = false
            dbRef.current?.close();
            dbRef.current = null
        };
    }, []);

    const save = useCallback(async (data: HistoryRecord) => {
        if (!dbRef.current) return;
        const record = HistoryRecordSchame.parse(data);
        await dbRef.current.put(STORE_NAME, record);
        const allRecords = await dbRef.current.getAll(STORE_NAME);
        setHistory(allRecords.sort((a, b) => b.createAt - a.createAt));
    }, []);

    const remove = useCallback(async (id: string) => {
        if (!dbRef.current) return;
        await dbRef.current.delete(STORE_NAME, id);
        const allRecords = await dbRef.current.getAll(STORE_NAME);
        setHistory(allRecords.sort((a, b) => b.createAt - a.createAt));
    }, []);

    const clear = useCallback(async () => {
        if (!dbRef.current) return;
        await dbRef.current.clear(STORE_NAME);
        setHistory([]);
    }, []);

    return {
        history,
        save,
        remove,
        clear
    };
}