import { upload } from "@vercel/blob/client";

interface Ocr02UploadInput {
  pathname: string;
  file: File;
  importId: string;
  fileId: string;
  csrfToken: string;
  onProgress?: (percentage: number) => void;
}

declare global {
  interface Window {
    uploadOcr02File?: (input: Ocr02UploadInput) => Promise<void>;
  }
}

window.uploadOcr02File = async ({
  pathname,
  file,
  importId,
  fileId,
  csrfToken,
  onProgress,
}: Ocr02UploadInput): Promise<void> => {
  await upload(pathname, file, {
    access: "private",
    contentType: "application/pdf",
    handleUploadUrl: "/api/ocr/imports/upload",
    headers: { "x-csrf-token": csrfToken },
    clientPayload: JSON.stringify({ importId, fileId }),
    multipart: file.size > 4 * 1024 * 1024,
    onUploadProgress: ({ percentage }) => onProgress?.(percentage),
  });
};

window.dispatchEvent(new Event("ocr02-upload-ready"));

