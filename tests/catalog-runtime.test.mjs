import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { matchingCache, publishCatalog } from '../scripts/catalog-runtime.mjs';
import { createDesktopInstaller } from '../scripts/desktop-config.mjs';

test('a cache from another Codex release or without a version is not reused',()=>{
  assert.equal(matchingCache({client_version:'0.163.0',models:[{}]},'0.165.0-alpha.1.2'),false);
  assert.equal(matchingCache({models:[{}]},'0.165.0-alpha.1.2'),false);
  assert.equal(matchingCache({client_version:'0.165.0',models:[{}]},'0.165.0-alpha.1.2'),true);
});

test('rejected catalogs leave the published catalog intact and remove temporary candidates',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'bridge-catalog-'));
  try {
    const path=join(dir,'models.json'); writeFileSync(path,'original');
    await assert.rejects(publishCatalog('unused',path,{models:[{slug:'a'}]},{validate:async(_cli,candidate)=>{
      assert.equal(statSync(candidate).mode&0o777,0o600);
      assert.equal(JSON.parse(readFileSync(candidate)).models[0].slug,'a');
      throw new Error('native schema rejection');
    }}),/native schema rejection/);
    assert.equal(readFileSync(path,'utf8'),'original');
    assert.deepEqual(readdirSync(dir),['models.json']);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('only successfully parsed candidates replace the published catalog',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'bridge-catalog-'));
  try {
    const path=join(dir,'models.json');const receipt={clientVersion:'test'};
    assert.deepEqual(await publishCatalog('unused',path,{models:[{slug:'a'}]},{validate:async(_cli,candidate,aliases)=>{
      assert.deepEqual(aliases,['a']);assert.equal(JSON.parse(readFileSync(candidate)).models[0].slug,'a');return receipt;
    }}),receipt);
    assert.equal(JSON.parse(readFileSync(path)).models[0].slug,'a');
    assert.deepEqual(readdirSync(dir),['models.json']);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('activation cannot touch user config or backups when native catalog validation fails',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'bridge-config-'));
  try {
    const path=join(dir,'config.toml');writeFileSync(path,'# model_catalog_json = "disabled-by-user"\nmodel = "original"\n');
    let called=false;
    const installer=createDesktopInstaller({cli:'unused',root:dir,stateDir:dir,baseUrl:'http://127.0.0.1:1',connectionFile:'unused',catalogPath:'unused',config:{routes:{a:{}}},
      validate:async()=>{throw new Error('schema rejection');},runRpc:async()=>{called=true;}});
    await assert.rejects(installer.activate('a'),/schema rejection/);
    assert.equal(called,false);assert.match(readFileSync(path,'utf8'),/^# model_catalog_json/);
    assert.deepEqual(readdirSync(dir),['config.toml']);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
