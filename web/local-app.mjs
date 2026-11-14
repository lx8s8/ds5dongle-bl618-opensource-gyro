export async function initLocalApp({beforeQuit,message}){
 try{const response=await fetch('/api/local');if(!response.ok)return;const info=await response.json();if(info.application!=='DS5 Control Center')return;const button=document.createElement('button');button.textContent='退出本地工具';button.onclick=async()=>{try{await beforeQuit();const r=await fetch('/api/quit',{method:'POST',headers:{'X-Session-Token':info.token}});if(!r.ok)throw new Error('退出失败');message('本地工具已退出，可以关闭此页面');button.disabled=true;}catch(e){message(e.message,true);}};document.querySelector('footer').append(button);}catch{}
}
