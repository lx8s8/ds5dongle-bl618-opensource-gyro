import {parseDeviceVersion,findUpdate,verifyDigest,createLocalDownloader,parseReleaseTag,compareVersions} from './updates.mjs';
export const repositories={gyro:'lx8s8/ds5dongle-bl618-opensource-gyro',upstream:'sqlCRT/ds5dongle-bl618-opensource'};
export function releaseAssets(release,board,usb,upstream=false){const re=new RegExp('(?:^|[-_])'+board+'(?:[-_.])','i');return(release.assets||[]).filter(a=>re.test(a.name)&&/\.zip$/i.test(a.name)&&(upstream||(usb==='hs'&&/(?:[-_.])hs(?:[-_.])/i.test(a.name))||(usb==='fs'&&!/(?:[-_.])hs(?:[-_.])/i.test(a.name))));}
export function bootManagerAssets(release,board='lctech616',usb='fs'){const re=new RegExp(`^ds5-boot-manager-${board}-${usb}(?:[-.]|$)`,'i');return(release.assets||[]).filter(a=>re.test(a.name)&&/\.bin$/i.test(a.name));}
export function safeAssetURL(url,repo){try{const u=new URL(url);return u.protocol==='https:'&&u.hostname==='github.com'&&u.pathname.startsWith('/'+repo+'/releases/download/');}catch{return false;}}
export async function fetchReleases(repo,{fetcher=globalThis.fetch,signal}={}){const response=await fetcher(`https://api.github.com/repos/${repo}/releases?per_page=30`,{headers:{Accept:'application/vnd.github+json'},signal});if(!response.ok)throw new Error(response.status===403||response.status===429?'GitHub 请求限额或访问受限，请稍后重试':'无法读取 Releases（HTTP '+response.status+'）');const data=await response.json();if(!Array.isArray(data))throw new Error('GitHub 返回格式不正确');return data.filter(r=>!r.draft);}
const nativeFetch=globalThis.fetch,releaseCache=new Map();
export async function getCachedReleases(repo,{fetcher=globalThis.fetch,force=false,signal}={}){const useCache=fetcher===nativeFetch;if(useCache&&!force&&releaseCache.has(repo))return releaseCache.get(repo);const data=await fetchReleases(repo,{fetcher,signal});if(useCache)releaseCache.set(repo,data);return data;}
function compareReleaseOrder(a,b){const va=parseReleaseTag(a?.tag_name),vb=parseReleaseTag(b?.tag_name);if(va&&vb)return compareVersions(va,vb);const ta=Date.parse(a?.published_at||'')||0,tb=Date.parse(b?.published_at||'')||0;return ta===tb?0:Math.sign(ta-tb);}
export function findLatestReleaseAsset(releases,{includePrerelease=true,allowPrereleaseFallback=false,pickAssets}={}){
 const pickFrom=list=>{let best=null;for(const release of list){const assets=(pickAssets?pickAssets(release):[]).filter(Boolean);if(!assets.length)continue;if(!best||compareReleaseOrder(release,best.release)>0)best={release,asset:assets[0]};}return best;};
 const all=(releases||[]).filter(r=>!r.draft);
 const first=pickFrom(all.filter(r=>includePrerelease||!r.prerelease));
 if(first)return{...first,prereleaseFallback:false};
 if(!includePrerelease&&allowPrereleaseFallback){const fb=pickFrom(all);if(fb)return{...fb,prereleaseFallback:Boolean(fb.release.prerelease)};}
 return null;
}
export async function fetchVerifiedAsset({repo,release,asset,downloader,manualHint='并在下方对应选择框中选中该文件',openFallback=url=>window.open(url,'_blank','noopener')}){
 if(!safeAssetURL(asset?.browser_download_url,repo))throw new Error('附件下载地址不在允许仓库内');
 if(!downloader){openFallback?.(asset.browser_download_url);throw new Error('当前不是本地工具，浏览器无法直接读取 GitHub 附件。已打开下载页，下载完成后'+manualHint+'。');}
 let bytes;
 try{bytes=await downloader({repo,tag:release.tag_name,name:asset.name});}
 catch(dlErr){openFallback?.(asset.browser_download_url);throw new Error(dlErr.message+'（若仅开启了浏览器代理扩展，后台程序无法共享代理）。已自动调用浏览器下载 '+asset.name+'，下载完成后'+manualHint+'。');}
 if(asset.size&&bytes.length!==asset.size)throw new Error('下载不完整，请重试');
 const verified=await verifyDigest(bytes,asset.digest);
 return{bytes,verified};
}
const formatAssetSize=bytes=>bytes<1048576?(bytes/1024).toFixed(1)+' KB':(bytes/1024/1024).toFixed(2)+' MB';
export function initReleases({loadPackage,loadBootManager,notify}={}){const $=id=>document.getElementById(id);let releases=[],request,current=null,found=null,downloader=null,notified='',loadedRepo='',loadingRepo='';
 const probeLocal=async()=>{if(!downloader)downloader=await createLocalDownloader();return downloader;};
 async function downloadAsset(repo,release,asset,button,status,{confirmed=false,kind='package'}={}){button.disabled=true;status.classList.remove('error');
  try{status.textContent='正在下载 '+asset.name+'…';const dl=await probeLocal();
   const manualHint=kind==='manager'?'请在下方“双固件切换与维护 → 安装双固件 → 启动管理器 .bin”选择该文件':'请在下方“网页刷写固件 → 选择固件包”选中该 ZIP 即可刷写';
   let verified;
   try{
    const res=await fetchVerifiedAsset({repo,release,asset,downloader:dl,manualHint});
    verified=res.verified;
    if(kind==='manager'){await loadBootManager(asset.name,res.bytes,{scroll:true});status.textContent='已下载并填入启动管理器 '+asset.name+(verified?'（GitHub SHA256 一致）':'')+'。请在下方核对两个槽位固件后安装。';}
    else{await loadPackage(asset.name,res.bytes,{confirmed});if(!confirmed)$('webFlash')?.scrollIntoView({behavior:'smooth',block:'center'});status.textContent='已下载并填入 '+asset.name+(verified?'（GitHub SHA256 一致）':(asset.digest?'':'（GitHub 未提供摘要，已做包内检查）'))+'。按住 BOOT 插入接收器，确认后点“开始刷写”。刷写前建议先导出配置。';}
   }catch(err){if(kind!=='manager')$('webFlash')?.scrollIntoView({behavior:'smooth',block:'center'});throw err;}
  }catch(e){status.textContent=e.message;status.classList.add('error');}finally{button.disabled=false;}
 }
 function render(){renderList();evaluate();}
 function renderList(){const container=$('releaseList');container.replaceChildren();const source=$('releaseSource').value,repo=repositories[source],prerelease=$('includePrerelease').checked;const selected=releases.filter(r=>prerelease||!r.prerelease);if(!selected.length){container.textContent='暂无公开 Release。构建产物可从 GitHub Actions 下载；草稿发布不会出现在这里。';return;}
  const board=$('releaseBoard').value,usb=$('releaseUSB').value;
  for(const r of selected){const card=document.createElement('article');card.className='release-card';const title=document.createElement('h3');title.textContent=r.name||r.tag_name;const date=document.createElement('small');date.textContent=(r.prerelease?'预发布 · ':'')+(r.published_at?new Date(r.published_at).toLocaleDateString('zh-CN'):'');const notes=document.createElement('pre');notes.className='release-notes';notes.textContent=r.body||'未提供更新说明';const assets=releaseAssets(r,board,usb,source==='upstream');const mgrAssets=source==='gyro'?bootManagerAssets(r,board,usb):[];card.append(title,date,notes);
   const renderAsset=(a,kind)=>{if(!safeAssetURL(a.browser_download_url,repo))return;const sz=formatAssetSize(a.size);
    if(downloader&&(kind==='package'||loadBootManager)){const btn=document.createElement('button');btn.type='button';btn.className='file-button primary';btn.textContent=(kind==='manager'?'下载并填入启动管理器 · ':'下载并填入刷写 · ')+a.name+' ('+sz+')';btn.onclick=()=>downloadAsset(repo,r,a,btn,$('updateStatus').closest('.settings-card')?.hidden?(kind==='manager'?$('dualMessage'):$('flashMessage')):$('updateStatus'),{confirmed:false,kind});card.append(btn);}
    const link=document.createElement('a');link.className='file-button'+(downloader?'':' primary');link.href=a.browser_download_url;link.textContent=(kind==='manager'?'浏览器下载启动管理器 · ':'浏览器打开下载 · ')+a.name+' · '+sz;link.rel='noopener';card.append(link);if(a.digest){const checksum=document.createElement('code');checksum.textContent=a.digest;card.append(checksum);}};
   for(const a of assets)renderAsset(a,'package');
   for(const a of mgrAssets)renderAsset(a,'manager');
   if(!assets.length&&!mgrAssets.length){const hint=document.createElement('p');hint.className='hint';hint.textContent='此版本没有匹配当前板型 / USB 速度的包，请检查完整资源列表。';card.append(hint);}const full=document.createElement('a');full.textContent='完整发布与全部附件 ↗';full.href='https://github.com/'+repo+'/releases/tag/'+encodeURIComponent(r.tag_name);full.target='_blank';full.rel='noopener';card.append(full);container.append(card);
  }
 }

 const banner=(title,detail,{action=false}={})=>{$('updateBanner').hidden=false;$('updateTitle').textContent=title;$('updateDetail').textContent=detail;$('updateGet').hidden=!action;$('updateGet').disabled=false;};
 function evaluate(){const badge=$('updateBadge');badge.hidden=true;found=null;if(!current||loadedRepo!==repositories.gyro){$('updateBanner').hidden=true;return;}
  const repo=repositories.gyro,prerelease=$('includePrerelease').checked;
  found=findUpdate(releases.filter(r=>prerelease||!r.prerelease),current,r=>releaseAssets(r,current.board,current.usb||$('releaseUSB').value).filter(a=>safeAssetURL(a.browser_download_url,repo)));
  const mine='当前 '+$('firmware').textContent;
  if(!found){banner('没有找到匹配的固件',mine+'。此板型 / USB 速度暂无公开版本。');return;}
  if(!found.newer){banner('固件已是最新',mine+'，最新版本 '+found.release.tag_name+'。');return;}
  badge.hidden=false;
  banner('发现新固件 '+found.release.tag_name,mine+(current.usb?'':'。USB 速度按下方选择（'+$('releaseUSB').value.toUpperCase()+'），请确认与你的接收器一致')+'。下载后在下方按提示进入 BOOT 模式刷写。',{action:true});
  if(notified!==found.release.tag_name){notified=found.release.tag_name;notify?.('发现新固件 '+found.release.tag_name+'，可在“固件与更新”一键下载');}
 }
 $('updateGet').onclick=async()=>{if(!found?.newer)return;await downloadAsset(repositories.gyro,found.release,found.asset,$('updateGet'),$('updateStatus'),{confirmed:Boolean(current?.usb)});};
 function setCurrent(version){current=parseDeviceVersion(version);if(!current){evaluate();return;}$('releaseSource').value='gyro';$('upstreamNotice').hidden=true;$('releaseUSB').disabled=false;$('releaseBoard').value=current.board;if(current.usb)$('releaseUSB').value=current.usb;$('releasesLink').href='https://github.com/'+repositories.gyro+'/releases';if(loadedRepo===repositories.gyro)render();else if(loadingRepo!==repositories.gyro)refresh();}
 function clearCurrent(){current=null;found=null;notified='';evaluate();}
 async function refresh(){request?.abort();const controller=new AbortController();request=controller;const repo=repositories[$('releaseSource').value];loadingRepo=repo;$('releaseStatus').textContent='正在查询 GitHub…';$('releaseRefresh').disabled=true;const timer=setTimeout(()=>controller.abort(),15000);try{await probeLocal();releases=await getCachedReleases(repo,{force:true,signal:controller.signal});loadedRepo=repo;$('releaseStatus').textContent='已更新 · '+new Date().toLocaleTimeString('zh-CN');render();}catch(e){if(e.name!=='AbortError')$('releaseStatus').textContent=e.message;else $('releaseStatus').textContent='查询超时，可重试或打开 Releases';}finally{clearTimeout(timer);if(request===controller){request=null;loadingRepo='';}$('releaseRefresh').disabled=false;}}
 $('releaseRefresh').onclick=refresh;$('releaseSource').onchange=()=>{$('releaseList').replaceChildren();$('upstreamNotice').hidden=$('releaseSource').value!=='upstream';$('releaseUSB').disabled=$('releaseSource').value==='upstream';$('releasesLink').href='https://github.com/'+repositories[$('releaseSource').value]+'/releases';refresh();};for(const id of ['releaseBoard','releaseUSB','includePrerelease'])$(id).onchange=render;
 probeLocal().then(dl=>{if(dl&&releases.length)renderList();});
 let visited=false;function route(){if(location.hash==='#update'&&!visited){visited=true;const repo=repositories[$('releaseSource').value];if(loadedRepo!==repo&&loadingRepo!==repo)refresh();}}window.addEventListener('hashchange',route);route();
 return {setCurrent,clearCurrent};
}
