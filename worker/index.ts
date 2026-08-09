/** Cloudflare Worker composition root for the Vinext application. */
import {
    DEFAULT_DEVICE_SIZES,
    DEFAULT_IMAGE_SIZES,
    handleImageOptimization,
} from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { runWithStorageServices } from "../runtime/storage-context";
import {
    createStorageServices,
    type RuntimeStorageBindings,
} from "../storage/create-services";

interface AssetFetcher {
    fetch(request: Request): Promise<Response>;
}

interface ImageTransformer {
    output(options: {
        format: string;
        quality: number;
    }): Promise<{ response(): Response }>;
}

interface ImageInput {
    transform(options: Record<string, unknown>): ImageTransformer;
}

interface ImageBinding {
    input(stream: ReadableStream): ImageInput;
}

interface Env extends RuntimeStorageBindings {
    ASSETS: AssetFetcher;
    IMAGES: ImageBinding;
}

interface ExecutionContext {
    passThroughOnException(): void;
    waitUntil(promise: Promise<unknown>): void;
}

const worker = {
    async fetch(
        request: Request,
        env: Env,
        ctx: ExecutionContext
    ): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname === "/_vinext/image") {
            const allowedWidths = [
                ...DEFAULT_DEVICE_SIZES,
                ...DEFAULT_IMAGE_SIZES,
            ];
            return handleImageOptimization(
                request,
                {
                    fetchAsset: (path) => env.ASSETS.fetch(
                        new Request(new URL(path, request.url))
                    ),
                    transformImage: async (
                        body,
                        { width, format, quality }
                    ) => {
                        const transformOptions = width > 0 ? { width } : {};
                        const result = await env.IMAGES
                            .input(body)
                            .transform(transformOptions)
                            .output({ format, quality });
                        return result.response();
                    },
                },
                allowedWidths
            );
        }

        const services = createStorageServices(env);
        return runWithStorageServices(
            services,
            () => handler.fetch(request, env, ctx)
        );
    },
};

export default worker;
