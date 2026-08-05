const API_BASE = 'http://192.168.0.141:5000';

export const createUploadRecord = async (fileName: string, fileSize: number, deviceUuid?: string) => {
  const response = await fetch(`${API_BASE}/uploads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_name: fileName, file_size: fileSize, uploaded: false, device_uuid: deviceUuid }),
  });
  if (!response.ok) throw new Error('Failed to create upload record');
  return await response.json();
};

export const markUploadComplete = async (id: number) => {
  const response = await fetch(`${API_BASE}/uploads/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploaded: true }),
  });
  if (!response.ok) throw new Error('Failed to update upload record');
  return await response.json();
};

export const fetchUploads = async () => {
  const response = await fetch(`${API_BASE}/uploads`);
  if (!response.ok) throw new Error('Failed to fetch uploads');
  return await response.json();
};
