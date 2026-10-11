export function normalizeBillLocation(value) {
  if(!value || typeof value!=='object')throw new Error('位置卡片无效');
  const lat=value.latitude,lon=value.longitude;
  if(!['number','string'].includes(typeof lat) || !['number','string'].includes(typeof lon) || String(lat).trim()==='' || String(lon).trim()==='' || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon)) || Math.abs(Number(lat))>90 || Math.abs(Number(lon))>180)throw new Error('位置坐标无效');
  const label=String(value.label || '').replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,400);
  return {latitude:Number(lat),longitude:Number(lon),label};
}
export function billLocationText(value) {
  const location=normalizeBillLocation(value);
  return location.label || `纬度 ${location.latitude.toFixed(6)}，经度 ${location.longitude.toFixed(6)}`;
}

export function qqLocationFromSegments(segments) {
  for(const segment of segments) {
    if(segment.type==='location') {
      try{return normalizeBillLocation({latitude:segment.data?.lat,longitude:segment.data?.lon ?? segment.data?.lng,label:[segment.data?.title,segment.data?.content].filter(Boolean).join(' · ')});}catch{return null;}
    }
    if(segment.type!=='json')continue;
    try {
      const raw=segment.data?.data;if(typeof raw==='string' && raw.length>16384)continue;
      const card=typeof raw==='string'?JSON.parse(raw):raw;
      if(!card || !['com.tencent.map','com.tencent.map.show'].includes(card.app))continue;
      const item=card.meta?.['Location.Search'] || card.meta?.['Location.Show'];
      if(!item)continue;
      return normalizeBillLocation({latitude:item.lat ?? item.latitude,longitude:item.lng ?? item.lon ?? item.longitude,label:[item.name || item.title,item.address].filter(Boolean).join(' · ')});
    }catch{/* Ignore unsupported or malformed cards; never fetch card URLs. */}
  }
  return null;
}
