"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
  Children,
  cloneElement,
  type FC,
  isValidElement,
  type PropsWithChildren,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  type Control,
  type ControllerRenderProps,
  type DefaultValues,
  type FieldValues,
  type Resolver,
  type SubmitHandler,
  useForm,
} from "react-hook-form";
import type { ZodType } from "zod";

import {
  FormControl,
  FormDescription,
  FormField,
  FormLabel,
  FormMessage,
  Form as UIForm,
  FormItem as UIFormItem,
} from "../ui/form";

interface FormProps<T extends FieldValues> extends PropsWithChildren {
  schema: ZodType<T>;
  defaultValues?: DefaultValues<T>;
  onSubmit: SubmitHandler<T>;
  className?: string;
  disabled?: boolean;
}

/**
 * 高层表单封装 —— 基于 react-hook-form + zodResolver。
 *
 * 用法：
 * ```tsx
 * <Form schema={useSchema(MySchema)} defaultValues={...} onSubmit={...}>
 *   <FormItem name="username" label="用户名">
 *     <Input />
 *   </FormItem>
 *   <Button type="submit">提交</Button>
 * </Form>
 * ```
 */
export function Form<T extends FieldValues>({
  schema,
  defaultValues,
  onSubmit,
  className,
  disabled,
  children,
}: FormProps<T>) {
  // biome-ignore lint/suspicious/noExplicitAny: zod 4.x 与 zodResolver 类型微差
  const resolver: Resolver<T> = zodResolver(schema as any);
  const form = useForm<T>({ resolver, defaultValues });

  return (
    <UIForm {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className={className}
        noValidate
      >
        <fieldset
          disabled={disabled}
          style={{ all: "unset", display: "contents" }}
        >
          {children}
        </fieldset>
      </form>
    </UIForm>
  );
}

interface FormItemProps<T extends FieldValues> extends PropsWithChildren {
  name: string;
  label?: string | ReactNode;
  description?: string | ReactNode;
  control?: Control<T>;
  className?: string;
}

/**
 * 单个表单字段。children 单子节点时自动注入 react-hook-form field props。
 */
export const FormItem: FC<FormItemProps<FieldValues>> = ({
  name,
  label,
  description,
  control,
  className,
  children,
}) => {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <UIFormItem className={className}>
          {label ? <FormLabel>{label}</FormLabel> : null}
          <FormControl>
            {Children.count(children) === 1 && isValidElement(children)
              ? cloneElement(
                  children as ReactElement<ControllerRenderProps>,
                  field,
                )
              : children}
          </FormControl>
          {description ? (
            <FormDescription>{description}</FormDescription>
          ) : null}
          <FormMessage />
        </UIFormItem>
      )}
    />
  );
};
