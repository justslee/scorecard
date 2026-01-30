'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';

export default function Settings() {
  const [apiKey, setApiKey] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const key = localStorage.getItem('openai_api_key') || '';
    setApiKey(key);
  }, []);

  const handleSave = () => {
    localStorage.setItem('openai_api_key', apiKey);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleClear = () => {
    if (confirm('Clear API key?')) {
      localStorage.removeItem('openai_api_key');
      setApiKey('');
    }
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      {/* Header */}
      <header className="bg-green-700 p-4 sticky top-0 z-10">
        <div className="max-w-2xl mx-auto flex items-center gap-4">
          <Link href="/" className="p-2 hover:bg-green-600 rounded">
            ←
          </Link>
          <h1 className="text-xl font-bold">Settings</h1>
        </div>
      </header>

      <main className="max-w-2xl mx-auto p-4">
        {/* OCR Settings */}
        <section className="bg-gray-800 rounded-lg p-4 mb-6">
          <h2 className="text-lg font-semibold mb-4">📷 Scorecard Scanning</h2>
          
          <p className="text-sm text-gray-400 mb-4">
            To use the scorecard scanning feature, you need an OpenAI API key with access to GPT-4 Vision.
          </p>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-2">OpenAI API Key</label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
                className="w-full p-3 bg-gray-700 rounded-lg"
              />
            </div>

            <div className="flex gap-2">
              <button
                onClick={handleSave}
                className="flex-1 p-3 bg-green-600 hover:bg-green-700 rounded-lg font-bold"
              >
                {saved ? '✓ Saved!' : 'Save'}
              </button>
              {apiKey && (
                <button
                  onClick={handleClear}
                  className="p-3 bg-red-900/50 text-red-400 rounded-lg hover:bg-red-900"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          <div className="mt-4 p-3 bg-gray-700 rounded-lg text-sm">
            <p className="font-medium mb-2">How to get an API key:</p>
            <ol className="list-decimal list-inside space-y-1 text-gray-400">
              <li>Go to <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" className="text-green-400 underline">platform.openai.com/api-keys</a></li>
              <li>Create a new secret key</li>
              <li>Copy and paste it above</li>
            </ol>
          </div>
        </section>

        {/* About */}
        <section className="bg-gray-800 rounded-lg p-4">
          <h2 className="text-lg font-semibold mb-4">About Scorecard</h2>
          <p className="text-gray-400 text-sm">
            A simple golf scoring app with OCR scorecard scanning. 
            Track your rounds, enter scores hole-by-hole, or snap a photo 
            of your paper scorecard to auto-fill scores.
          </p>
          <div className="mt-4 pt-4 border-t border-gray-700 text-sm text-gray-500">
            <p>Version 1.0.0</p>
            <p className="mt-1">Data stored locally in your browser.</p>
          </div>
        </section>

        {/* Data Management */}
        <section className="mt-6 bg-gray-800 rounded-lg p-4">
          <h2 className="text-lg font-semibold mb-4">Data</h2>
          <button
            onClick={() => {
              if (confirm('This will delete ALL rounds and data. Continue?')) {
                localStorage.clear();
                window.location.href = '/';
              }
            }}
            className="w-full p-3 bg-red-900/50 text-red-400 rounded-lg hover:bg-red-900"
          >
            🗑️ Clear All Data
          </button>
        </section>
      </main>
    </div>
  );
}
