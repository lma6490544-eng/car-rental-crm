import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { link, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fail } from '../platform/security';

export const uploadLimit = 8 * 1024 * 1024;
export const checksum = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export function supportedFile(mime: string, bytes: Buffer, photo: boolean) {
  if (mime === 'image/png')
    return (
      bytes.length >= 45 &&
      bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) &&
      bytes.toString('ascii', 12, 16) === 'IHDR' &&
      bytes.subarray(-8, -4).toString('ascii') === 'IEND'
    );
  if (mime === 'image/jpeg')
    return (
      bytes.length >= 8 &&
      bytes.readUInt16BE(0) === 0xffd8 &&
      bytes.readUInt16BE(bytes.length - 2) === 0xffd9
    );
  return (
    !photo &&
    mime === 'application/pdf' &&
    bytes.subarray(0, 5).toString('ascii') === '%PDF-' &&
    bytes.subarray(-1024).toString('ascii').trimEnd().endsWith('%%EOF')
  );
}

@Injectable()
export class PrivateStorage {
  private readonly root = process.env.CRM_PRIVATE_FILES_DIR?.trim();
  get configured() {
    return !!this.root && isAbsolute(this.root);
  }

  private directory(staging: boolean) {
    if (!this.configured)
      fail(503, 'PRIVATE_STORAGE_UNAVAILABLE', 'Приватное хранилище не настроено.');
    return join(this.root!, staging ? 'incoming' : 'objects');
  }

  private location(id: string, staging = false) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid private storage key');
    return join(this.directory(staging), id);
  }

  async stage(id: string, bytes: Buffer) {
    await mkdir(this.directory(true), { recursive: true, mode: 0o700 });
    await writeFile(this.location(id, true), bytes, { mode: 0o600, flag: 'wx' });
  }

  async publish(id: string, stagedId: string) {
    await mkdir(this.directory(false), { recursive: true, mode: 0o700 });
    await link(this.location(stagedId, true), this.location(id)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      },
    );
    await this.remove(stagedId, true);
  }

  read(id: string, staging = false) {
    return readFile(this.location(id, staging));
  }

  remove(id: string, staging = false) {
    return rm(this.location(id, staging), { force: true });
  }

  async staleStaging() {
    const directory = this.directory(true);
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      },
    );
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const stale: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
      const info = await stat(this.location(entry.name, true)).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        },
      );
      if (info && info.mtimeMs < cutoff) stale.push(entry.name);
    }
    return stale;
  }
}
