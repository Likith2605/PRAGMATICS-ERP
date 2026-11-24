export const getBlobUrlFromDataUrl = (dataUrl) => {
  if (!dataUrl) return '';
  try {
    const arr = dataUrl.split(',');
    const mime = (arr[0].match(/:(.*?);/) || [])[1] || 'application/pdf';
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
      u8arr[n] = bstr.charCodeAt(n);
    }
    const blob = new Blob([u8arr], { type: mime });
    return URL.createObjectURL(blob);
  } catch (err) {
    console.error('Error creating blob from dataUrl', err);
    return dataUrl;
  }
};

export const viewDrawingFile = (dataUrl, fileName = 'drawing.pdf') => {
  if (!dataUrl) return;
  try {
    const blobUrl = getBlobUrlFromDataUrl(dataUrl);
    const win = window.open(blobUrl, '_blank');
    if (!win) {
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = fileName;
      a.click();
    }
  } catch (e) {
    console.error('Failed to open drawing', e);
  }
};
