import { useEffect, useState } from 'react';

export const useAuthoritativeData = (load, refreshKey = '', initialData = []) => {
  const [data, setData] = useState(initialData);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    load()
      .then((records) => { if (active) setData(records); })
      .catch((cause) => {
        if (!active) return;
        setData(initialData);
        setError(cause?.message || 'Authoritative report data could not be loaded.');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [load, refreshKey]);

  return { data, loading, error };
};
