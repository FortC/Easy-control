import { useEffect, useRef, useState } from 'react';
import { desktop, type Scene } from '../native.js';
export function splitScript(text:string):string[]{
  return text.split(/\n+/).flatMap(p=>p.trim().match(/.{1,300}(?:[。！？!?]|$)|.{1,300}/gu)||[]).map(s=>s.trim()).filter(Boolean);
}
export default function StagePage(){
  const [scene,setScene]=useState<Scene|null>(null),[caption,setCaption]=useState(''),[error,setError]=useState('');
  const video=useRef<HTMLVideoElement>(null),audio=useRef<HTMLAudioElement>(null),index=useRef(0),lastScript=useRef('');
  useEffect(()=>{void desktop.live.get().then(setScene);return desktop.live.onState(setScene);},[]);
  useEffect(()=>{if(!scene)return; if(lastScript.current!==scene.script){index.current=0;lastScript.current=scene.script;}if(scene.status==='stopped'){index.current=0;audio.current?.pause();video.current?.pause();setCaption('');if(video.current)video.current.currentTime=0;}if(scene.status==='paused'){audio.current?.pause();video.current?.pause();}if(scene.status==='running')void video.current?.play().catch(()=>{});},[scene?.status,scene?.script,scene?.videoUrl]);
  useEffect(()=>{
    if(!scene||scene.status!=='running')return;
    let active=true;const chunks=splitScript(scene.script);
    async function next(){
      if(!active||!scene||!chunks.length)return;
      if(index.current>=chunks.length){if(scene.loop)index.current=0;else {await desktop.live.command('stop');return;}}
      const text=chunks[index.current]!;setCaption(text);setError('');
      try {const r=await desktop.live.synthesize({text,voice:scene.voice,rate:scene.rate});if(!active||!audio.current)return;audio.current.src=r.url;audio.current.onended=()=>{index.current++;void next();};await audio.current.play();
        const upcoming=chunks[index.current+1];if(upcoming)void desktop.live.synthesize({text:upcoming,voice:scene.voice,rate:scene.rate}).catch(()=>{});
      }catch(e){if(active){setError(String(e));void desktop.live.command('pause');}}
    }
    void next();return()=>{active=false;if(audio.current){audio.current.pause();audio.current.onended=null;}};
  },[scene?.status,scene?.script,scene?.voice,scene?.rate,scene?.loop]);
  if(!scene)return <div className="stage-root">正在准备画面…</div>;
  return <div className="stage-root"><div className={`stage-surface ${scene.orientation}`}>
    {scene.videoUrl?<video ref={video} src={scene.videoUrl} muted={scene.muted} loop playsInline/>:<div className="stage-no-video"><span>PRODUCT PRESENTATION</span><h1>{scene.title}</h1></div>}
    <div className="stage-label">AI 辅助讲解 <span>· {scene.status==='running'?'正在讲解':scene.status==='paused'?'暂停':'待开始'}</span></div>
    <div className="stage-caption"><h2>{scene.title}</h2><p>{caption||'欢迎来到直播间'}</p></div>{error&&<div className="stage-error">语音暂停，请返回工作台检查。</div>}
    <audio ref={audio}/>
  </div></div>;
}
