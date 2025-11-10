# S3-Compatible Storage Configuration for Supabase

Supabase Storage provides an S3-compatible API that can be accessed directly using the AWS S3 SDK. This allows for more flexible storage operations and better compatibility with existing S3 tools.

## Configuration

### Environment Variables

Add the following environment variables to your `.env` file:

```env
# S3-Compatible Storage Configuration
S3_ENDPOINT=https://xvnxmypqmxzjkbmgtkzf.storage.supabase.co/storage/v1/s3
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=your_supabase_service_role_key
S3_SECRET_ACCESS_KEY=your_supabase_service_role_secret
S3_BUCKET=video

# Alternative naming (for backward compatibility)
SUPABASE_S3_ENDPOINT=https://xvnxmypqmxzjkbmgtkzf.storage.supabase.co/storage/v1/s3
SUPABASE_S3_REGION=us-east-1
SUPABASE_ACCESS_KEY=your_supabase_service_role_key
SUPABASE_SECRET_KEY=your_supabase_service_role_secret
```

### Getting Your Credentials

1. **S3 Endpoint**: 
   - Format: `https://[project-id].storage.supabase.co/storage/v1/s3`
   - Your endpoint: `https://xvnxmypqmxzjkbmgtkzf.storage.supabase.co/storage/v1/s3`

2. **Region**: 
   - Default: `us-east-1`
   - Check your Supabase project settings for the actual region

3. **Access Key ID**: 
   - Use your Supabase **Service Role Key** (not the anon key)
   - Found in: Supabase Dashboard → Settings → API → `service_role` key
   - **Important**: This is the same value you'll use for Secret Access Key

4. **Secret Access Key**: 
   - Use the same **Service Role Key** as the Access Key ID
   - For Supabase S3 API, both Access Key ID and Secret Access Key use the service role key
   - This is different from AWS S3, where they would be different values

5. **Bucket Name**: 
   - The name of your storage bucket (e.g., `video`, `public-assets`)
   - Create buckets in: Supabase Dashboard → Storage

## Storage Type Selection

The application will automatically use S3-compatible storage if:
- `S3_ENDPOINT` (or `SUPABASE_S3_ENDPOINT`) is set
- `S3_ACCESS_KEY_ID` (or `SUPABASE_ACCESS_KEY`) is set
- `S3_SECRET_ACCESS_KEY` (or `SUPABASE_SECRET_KEY`) is set

Otherwise, it falls back to the Supabase JS client (existing implementation).

## Usage

### Using S3 Storage

```typescript
import { uploadToS3, getS3SignedUrl, getS3PublicUrl } from './lib/s3-storage';

// Upload a file
const fileBuffer = Buffer.from(fileData);
const url = await uploadToS3('path/to/file.mp4', fileBuffer, 'video/mp4');

// Get a signed URL (for private buckets)
const signedUrl = await getS3SignedUrl('path/to/file.mp4', 3600); // expires in 1 hour

// Get a public URL (for public buckets)
const publicUrl = getS3PublicUrl('path/to/file.mp4');
```

### Using Unified Storage (Automatic Selection)

```typescript
import { getStorageType, isStorageConfigured } from './lib/storage-config';

const storageType = getStorageType(); // 's3' or 'supabase'
const isConfigured = isStorageConfigured(); // true or false
```

## Benefits of S3-Compatible Storage

1. **Direct API Access**: Use standard S3 APIs without Supabase JS client overhead
2. **Better Performance**: Direct S3 operations can be faster for large files
3. **Tool Compatibility**: Works with existing S3 tools and libraries
4. **Flexibility**: Can switch to other S3-compatible storage providers easily

## Security Notes

1. **Service Role Key**: Never expose your service role key in client-side code
2. **Private Buckets**: Use signed URLs for private buckets
3. **Public Buckets**: Only use public buckets for non-sensitive data
4. **Environment Variables**: Keep credentials in `.env` file (never commit to git)

## Testing

To test S3 storage configuration:

```typescript
import { isS3StorageAvailable, getS3Config } from './lib/s3-storage';

console.log('S3 Available:', isS3StorageAvailable());
console.log('S3 Config:', getS3Config());
```

## Troubleshooting

### Error: "S3 client not configured"
- Check that all required environment variables are set
- Verify your `.env` file is loaded correctly
- Ensure no typos in variable names

### Error: "Access Denied"
- Verify your service role key is correct
- Check that the bucket exists in Supabase
- Ensure the bucket permissions are set correctly

### Error: "Invalid endpoint"
- Verify the endpoint URL format
- Check that the project ID in the URL is correct
- Ensure the endpoint includes `/storage/v1/s3`

## References

- [Supabase Storage S3 API](https://supabase.com/docs/guides/storage/s3-api)
- [AWS S3 SDK Documentation](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/s3-examples.html)
- [Supabase Storage Buckets](https://supabase.com/docs/guides/storage/buckets)

