// Inspect→code (Phase 5) : script injecté dans le <webview> de preview. En mode inspect, surligne au survol
// et, au clic, remonte la source de l'élément (React fiber `_debugSource`, prop `__source`, ou data-attributs
// type react-dev-inspector) puis la renvoie à l'hôte via console.log préfixé (capté par l'event console-message).
// « if mappable » : ne marche que si l'app prévisualisée expose la source (dev React/Vite/Next, ou data-attrs).

export const INSPECT_SENTINEL = 'ORYON_INSPECT:'

/** Script idempotent : installe window.__oryonInspect (enable/disable) si absent. */
export const INSPECT_INSTALL = `
(function(){
  if (window.__oryonInspect) return;
  var SENT = ${JSON.stringify(INSPECT_SENTINEL)};
  function findSource(start){
    var node = start;
    while (node && node.nodeType === 1) {
      var ds = node.dataset || {};
      var rel = ds.inspectorRelativePath || ds.sourcefile || ds.source;
      if (rel) return { fileName: rel, lineNumber: parseInt(ds.inspectorLine || ds.line || '0', 10) || undefined };
      var key = Object.keys(node).find(function(k){ return k.indexOf('__reactFiber$')===0 || k.indexOf('__reactInternalInstance$')===0; });
      if (key) {
        var fiber = node[key];
        var guard = 0;
        while (fiber && guard++ < 200) {
          var src = fiber._debugSource || (fiber.memoizedProps && fiber.memoizedProps.__source);
          if (src && src.fileName) return { fileName: src.fileName, lineNumber: src.lineNumber, columnNumber: src.columnNumber };
          fiber = fiber.return;
        }
      }
      node = node.parentElement;
    }
    return null;
  }
  var hl = document.createElement('div');
  hl.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;background:rgba(0,229,153,0.18);border:1px solid rgba(0,229,153,0.9);border-radius:2px;display:none;transition:all .04s';
  var tag = document.createElement('div');
  tag.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;font:11px ui-monospace,monospace;background:#00e599;color:#08120d;padding:1px 5px;border-radius:3px;display:none';
  function onMove(e){
    var el = e.target;
    if (!el || el === hl || el === tag) return;
    var r = el.getBoundingClientRect();
    hl.style.display='block'; hl.style.left=r.left+'px'; hl.style.top=r.top+'px'; hl.style.width=r.width+'px'; hl.style.height=r.height+'px';
    var s = findSource(el);
    if (s && s.fileName){ var p=s.fileName.split(/[\\\\/]/).pop(); tag.style.display='block'; tag.textContent='<'+(el.tagName.toLowerCase())+'> '+p+(s.lineNumber?(':'+s.lineNumber):''); tag.style.left=r.left+'px'; tag.style.top=Math.max(0,r.top-18)+'px'; }
    else tag.style.display='none';
  }
  function onClick(e){
    e.preventDefault(); e.stopPropagation();
    var s = findSource(e.target);
    console.log(SENT + JSON.stringify(s || { none: true }));
  }
  var on = false;
  function enable(){ if(on) return; on=true; document.addEventListener('mousemove',onMove,true); document.addEventListener('click',onClick,true); document.addEventListener('mouseover',onMove,true); document.documentElement.style.cursor='crosshair'; if(!hl.parentNode){document.body.appendChild(hl);document.body.appendChild(tag);} }
  function disable(){ on=false; document.removeEventListener('mousemove',onMove,true); document.removeEventListener('click',onClick,true); document.removeEventListener('mouseover',onMove,true); document.documentElement.style.cursor=''; hl.style.display='none'; tag.style.display='none'; }
  window.__oryonInspect = { enable: enable, disable: disable };
})();
`
